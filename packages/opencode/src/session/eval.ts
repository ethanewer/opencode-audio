import { Session } from "."
import { SessionPrompt } from "./prompt"
import { SessionSummary } from "./summary"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { Permission } from "../permission"
import { Log } from "../util/log"

export namespace Eval {
  const log = Log.create({ service: "session.eval" })

  export type Issue = {
    file?: string
    description: string
    severity: string
  }

  export type Result = {
    pass: boolean
    summary: string
    issues?: Issue[]
    attempt: number
    sessionID: SessionID
  }

  /**
   * Extract the user instruction from a session.
   * If the conversation is simple (single user message, or plan accepted first try),
   * returns the raw text directly. Otherwise runs the extract agent to summarize.
   */
  export async function extract(
    sessionID: SessionID,
    model?: { providerID: ProviderID; modelID: ModelID },
  ): Promise<string> {
    const msgs = await Session.messages({ sessionID })

    // Collect non-synthetic user text parts
    const parts: string[] = []
    let count = 0
    for (const msg of msgs) {
      if (msg.info.role !== "user") continue
      for (const part of msg.parts) {
        if (part.type !== "text") continue
        if ("synthetic" in part && part.synthetic) continue
        if ("ignored" in part && part.ignored) continue
        const text = part.text.trim()
        if (!text) continue
        parts.push(text)
        count++
      }
    }

    // Simple case: single user message — use it directly
    if (count <= 1 && parts.length > 0) {
      log.info("using direct instruction", { count })
      return parts.join("\n\n")
    }

    // No user messages found
    if (parts.length === 0) {
      log.warn("no user messages found")
      return ""
    }

    // Complex case: multiple user messages — run extraction agent
    log.info("running extraction agent", { count })
    const resolved = model ?? (await Provider.defaultModel())
    const mdl = await Provider.getModel(resolved.providerID, resolved.modelID)

    const rules: Permission.Ruleset = [{ permission: "question", action: "deny", pattern: "*" }]
    const session = await Session.create({
      parentID: sessionID,
      title: "Instruction Extraction",
      permission: rules,
    })

    const history = await MessageV2.toModelMessages(msgs, mdl, { stripMedia: true })
    const prompt = [
      "Below is a conversation between a user and coding agents. Extract the user's instructions and goals.\n",
      ...history.map((m) => {
        const role = m.role === "user" ? "User" : "Assistant"
        const content =
          typeof m.content === "string"
            ? m.content
            : Array.isArray(m.content)
              ? m.content
                  .filter((p): p is { type: "text"; text: string } => "type" in p && p.type === "text")
                  .map((p) => p.text)
                  .join("\n")
              : ""
        return `[${role}]\n${content}`
      }),
    ].join("\n\n")

    const result = await SessionPrompt.prompt({
      sessionID: session.id,
      agent: "extract",
      model: resolved,
      parts: [{ type: "text", text: prompt }],
    })

    // Get the extract agent's text response
    for (const part of result.parts) {
      if (part.type === "text" && part.text.trim()) {
        return part.text.trim()
      }
    }

    // Fallback to concatenated user messages
    return parts.join("\n\n")
  }

  /**
   * Parse the eval_result tool call from a completed eval session.
   */
  function parse(msgs: MessageV2.WithParts[]): { pass: boolean; summary: string; issues?: Issue[] } | undefined {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j]
        if (part.type !== "tool") continue
        if (part.tool !== "eval_result") continue
        if (part.state.status !== "completed") continue
        const meta = "metadata" in part.state ? part.state.metadata : undefined
        if (meta && typeof meta === "object" && "pass" in meta) {
          return {
            pass: Boolean(meta.pass),
            summary: String((meta as Record<string, unknown>).summary ?? ""),
            issues: (meta as Record<string, unknown>).issues as Issue[] | undefined,
          }
        }
        // Try parsing from output
        try {
          const parsed = JSON.parse(part.state.output)
          return {
            pass: Boolean(parsed.pass),
            summary: String(parsed.summary ?? ""),
            issues: parsed.issues,
          }
        } catch {
          continue
        }
      }
    }
    return undefined
  }

  /**
   * Compose the eval prompt from user instructions and diff.
   */
  function compose(instruction: string, diff: string, files: string[]): string {
    const parts = [
      "## Original User Instructions\n",
      instruction,
      "\n\n## Modified Files\n",
      files.length > 0 ? files.map((f) => `- ${f}`).join("\n") : "(no files modified)",
      "\n\n## Git Diff of Changes\n",
      diff || "(no changes detected)",
      "\n\n---\n",
      "Please evaluate whether the changes above correctly and completely fulfill the original user instructions.",
      "Read the modified files to see the full context, run tests if applicable, and then call the eval_result tool with your verdict.",
    ]
    return parts.join("\n")
  }

  /**
   * Compose feedback from eval issues to send back to the build agent.
   */
  function feedback(result: { summary: string; issues?: Issue[] }): string {
    const parts = [
      "An evaluation agent has reviewed your work and found the following issues that need to be fixed:\n",
      `**Summary:** ${result.summary}\n`,
    ]
    if (result.issues?.length) {
      parts.push("**Issues:**\n")
      for (const issue of result.issues) {
        const prefix = issue.severity === "error" ? "ERROR" : "WARNING"
        const loc = issue.file ? ` (${issue.file})` : ""
        parts.push(`- [${prefix}]${loc}: ${issue.description}`)
      }
    }
    parts.push("\nPlease fix these issues and ensure the task is completed correctly.")
    return parts.join("\n")
  }

  /**
   * Run the eval-build loop.
   *
   * Creates fresh eval sessions to review the build output.
   * If problems are found, feeds them back to the build session and repeats.
   */
  export async function run(input: {
    sessionID: SessionID
    instruction: string
    model?: { providerID: ProviderID; modelID: ModelID }
    max?: number
    onAttempt?: (attempt: number, max: number) => void
    onResult?: (result: Result) => void
    onSession?: (sessionID: SessionID) => void
  }): Promise<Result> {
    const max = input.max ?? 5
    const resolved = input.model ?? (await Provider.defaultModel())
    const rules: Permission.Ruleset = [
      { permission: "question", action: "deny", pattern: "*" },
      { permission: "plan_enter", action: "deny", pattern: "*" },
      { permission: "plan_exit", action: "deny", pattern: "*" },
    ]

    let last: Result = {
      pass: false,
      summary: "Eval did not complete",
      attempt: 0,
      sessionID: input.sessionID,
    }

    for (let attempt = 1; attempt <= max; attempt++) {
      input.onAttempt?.(attempt, max)
      log.info("eval attempt", { attempt, max })

      // Get diff from the build session
      const diffs = await SessionSummary.diff({ sessionID: input.sessionID }).catch(() => [])
      const files = diffs.map((d) => d.file)
      const diffText = diffs
        .map((d) => {
          const header = `--- ${d.status === "added" ? "/dev/null" : d.file}\n+++ ${d.status === "deleted" ? "/dev/null" : d.file}`
          // We don't have a unified diff string, but we have before/after
          // Construct a basic summary
          return `${header}\n(${d.additions} additions, ${d.deletions} deletions, status: ${d.status ?? "modified"})`
        })
        .join("\n\n")

      // Create a fresh eval session
      const evalSession = await Session.create({
        parentID: input.sessionID,
        title: `Eval attempt ${attempt}`,
        permission: rules,
      })

      // Notify caller about the new eval session
      input.onSession?.(evalSession.id)

      // Send eval prompt
      const prompt = compose(input.instruction, diffText, files)
      await SessionPrompt.prompt({
        sessionID: evalSession.id,
        agent: "eval",
        model: resolved,
        parts: [{ type: "text", text: prompt }],
      })

      // Parse result from eval session
      const evalMsgs = await Session.messages({ sessionID: evalSession.id })
      const result = parse(evalMsgs)

      last = {
        pass: result?.pass ?? false,
        summary: result?.summary ?? "Eval agent did not call eval_result",
        issues: result?.issues,
        attempt,
        sessionID: evalSession.id,
      }

      input.onResult?.(last)

      if (last.pass) {
        log.info("eval passed", { attempt })
        return last
      }

      // If this is the last attempt, don't send feedback
      if (attempt >= max) {
        log.info("max eval iterations reached", { attempt, max })
        return last
      }

      // Send feedback to build session
      log.info("eval failed, sending feedback to build", { attempt })
      const fb = feedback(last)
      await SessionPrompt.prompt({
        sessionID: input.sessionID,
        agent: "build",
        model: resolved,
        parts: [{ type: "text", text: fb }],
      })
    }

    return last
  }
}
