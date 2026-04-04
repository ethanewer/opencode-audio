import { Session } from "."
import { SessionPrompt } from "./prompt"
import { SessionSummary } from "./summary"
import { MessageV2 } from "./message-v2"
import { SessionID } from "./schema"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { Permission } from "../permission"
import { Log } from "../util/log"
import { createTwoFilesPatch } from "diff"

export namespace Eval {
  const log = Log.create({ service: "session.eval" })

  const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch"])
  export const REBUT = "eval_rebuttal"
  export const MAX_REBUT = 3

  export type Phase = "evaluating" | "failed" | "rebutting" | "passed"

  export type Issue = {
    file?: string
    description: string
    severity: string
  }

  export type State = {
    sessionId: string
    mode: "interactive" | "headless"
    policy: "stop_on_accept" | "rerun_on_accept"
    phase: Phase
    round: number
    summary?: string
    pass?: boolean
    rebutted?: boolean
  }

  export type Rebuttal = {
    content: string
  }

  export type Result = {
    pass: boolean
    summary: string
    issues?: Issue[]
    attempt: number
    sessionID: SessionID
    sessions: SessionID[]
    round: number
    phase: Phase
    rebutted?: boolean
  }

  function parseState(input: unknown) {
    if (!input || typeof input !== "object") return
    const data = input as Record<string, unknown>
    if (typeof data.sessionId !== "string") return
    if (data.mode !== "interactive" && data.mode !== "headless") return
    if (data.policy !== "stop_on_accept" && data.policy !== "rerun_on_accept") return
    if (data.phase !== "evaluating" && data.phase !== "failed" && data.phase !== "rebutting" && data.phase !== "passed")
      return
    if (typeof data.round !== "number") return
    return {
      sessionId: data.sessionId,
      mode: data.mode,
      policy: data.policy,
      phase: data.phase,
      round: data.round,
      ...(typeof data.summary === "string" ? { summary: data.summary } : {}),
      ...(typeof data.pass === "boolean" ? { pass: data.pass } : {}),
      ...(typeof data.rebutted === "boolean" ? { rebutted: data.rebutted } : {}),
    } satisfies State
  }

  export function metadata(input: State) {
    return { eval: input }
  }

  export function state(part?: { metadata?: Record<string, unknown> }) {
    if (!part?.metadata || typeof part.metadata !== "object") return
    if (!("eval" in part.metadata)) return
    return parseState(part.metadata.eval)
  }

  export function pending(msgs: MessageV2.WithParts[]) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info.role !== "user") continue
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j]
        if (part.type !== "text" || part.ignored) continue
        const meta = state(part)
        if (meta?.phase !== "failed") continue
        return {
          message: msg,
          part,
          state: meta,
        }
      }
    }
  }

  export async function resolve(part?: MessageV2.TextPart) {
    if (!part || part.ignored) return
    await Session.updatePart({
      ...part,
      ignored: true,
    })
  }

  /**
   * Count non-synthetic, non-ignored, non-eval user text parts from messages.
   * Shared between headless (Eval.extract) and TUI (prompt.ts handleSubtask) paths.
   */
  export function instruction(msgs: MessageV2.WithParts[]): { count: number; single: string } {
    let count = 0
    let single = ""
    for (const msg of msgs) {
      if (msg.info.role !== "user") continue
      if (msg.parts.some((p) => p.type === "subtask" && "command" in p && p.command === "eval")) continue
      for (const part of msg.parts) {
        if (part.type !== "text") continue
        if ("synthetic" in part && part.synthetic) continue
        if ("ignored" in part && part.ignored) continue
        if ("eval" in part && part.eval) continue
        if (state(part)) continue
        const text = part.text.trim()
        if (!text) continue
        count++
        if (count === 1) single = text
      }
    }
    return { count, single }
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
    const { count, single } = instruction(msgs)

    if (count <= 1 && single) {
      log.info("using direct instruction", { count })
      return single
    }

    if (!single) {
      log.warn("no user messages found")
      return ""
    }

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

    for (const part of result.parts) {
      if (part.type === "text" && part.text.trim()) {
        return part.text.trim()
      }
    }

    return single
  }

  export function parse(msgs: MessageV2.WithParts[]): { pass: boolean; summary: string; issues?: Issue[] } | undefined {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      for (let j = msg.parts.length - 1; j >= 0; j--) {
        const part = msg.parts[j]
        if (part.type !== "tool") continue
        if (part.tool !== "eval_result") continue
        if (part.state.status !== "completed") continue
        const meta = part.state.metadata
        if (meta && typeof meta === "object" && "pass" in meta) {
          return {
            pass: Boolean(meta.pass),
            summary: String((meta as Record<string, unknown>).summary ?? ""),
            issues: (meta as Record<string, unknown>).issues as Issue[] | undefined,
          }
        }
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

  export function rebut(parts: MessageV2.Part[]) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (part.type !== "tool") continue
      if (part.tool !== REBUT) continue
      if (part.state.status !== "completed") continue
      const meta = part.state.metadata
      if (meta && typeof meta === "object" && typeof meta.content === "string") {
        return { content: meta.content } satisfies Rebuttal
      }
      const input = part.state.input as Record<string, unknown> | undefined
      if (input && typeof input.content === "string") {
        return { content: input.content } satisfies Rebuttal
      }
    }
  }

  function turn(msgs: MessageV2.WithParts[]) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.info.role !== "user") continue
      if (
        msg.parts.every((part) => {
          if (part.type === "subtask") return part.command === "eval"
          if (part.type === "text") return part.eval === true || !!state(part)
          return false
        })
      )
        continue
      return {
        agent: msg.info.agent,
        model: msg.info.model,
      }
    }
  }

  function patch(diffs: Array<{ file: string; before: string; after: string; status?: string }>) {
    return diffs
      .map((item) => {
        const prev = item.status === "added" ? "/dev/null" : item.file
        const next = item.status === "deleted" ? "/dev/null" : item.file
        return createTwoFilesPatch(prev, next, item.before, item.after)
      })
      .join("\n")
  }

  function fallback(msgs: MessageV2.WithParts[]) {
    const files = new Set<string>()
    const diffs = [] as string[]
    for (const msg of msgs) {
      for (const part of msg.parts) {
        if (part.type !== "tool") continue
        if (!WRITE_TOOLS.has(part.tool)) continue
        if (part.state.status !== "completed") continue
        const meta = part.state.metadata
        const input = ("input" in part.state ? part.state.input : undefined) as Record<string, unknown> | undefined
        if (!input) continue
        if (typeof input.filePath === "string") files.add(input.filePath)
        if (Array.isArray(input.edits)) {
          for (const edit of input.edits) {
            if (typeof edit === "object" && edit && typeof (edit as Record<string, unknown>).filePath === "string") {
              files.add((edit as Record<string, unknown>).filePath as string)
            }
          }
        }
        if (meta && typeof meta === "object") {
          if ("diff" in meta && typeof meta.diff === "string" && meta.diff.trim()) diffs.push(meta.diff)
          if (Array.isArray(meta.files)) {
            for (const item of meta.files) {
              if (!item || typeof item !== "object") continue
              if ("filePath" in item && typeof item.filePath === "string") files.add(item.filePath)
              if ("movePath" in item && typeof item.movePath === "string") files.add(item.movePath)
            }
          }
          if ("filediff" in meta && meta.filediff && typeof meta.filediff === "object") {
            const next = meta.filediff as Record<string, unknown>
            if (typeof next.file === "string") files.add(next.file)
          }
        }
      }
    }
    return {
      files: [...files],
      diff: diffs.join("\n\n"),
    }
  }

  function compose(instruction: string, diff: string, files: string[], hasDiff: boolean): string {
    const parts = ["## Original User Instructions\n", instruction]

    if (files.length > 0) {
      parts.push("\n\n## Files Created or Modified\n")
      parts.push(files.map((f) => `- ${f}`).join("\n"))
    }

    if (hasDiff) {
      parts.push("\n\n## Diff of Changes\n")
      parts.push(diff)
    } else if (files.length > 0) {
      parts.push("\n\nNo diff is available. Read the listed files directly to verify their contents.")
    }

    if (files.length === 0 && !hasDiff) {
      parts.push(
        "\n\nNo file modifications were detected. The agent may have performed actions without writing files, or the tracking may be incomplete. Use your tools to investigate whether the task was completed.",
      )
    }

    parts.push("\n\n---\n")
    parts.push("Evaluate whether the original user instructions were fulfilled correctly and completely.")
    parts.push(
      "Read the relevant files, run tests if applicable, and then call the eval_result tool with your verdict.",
    )
    return parts.join("\n")
  }

  export function feedback(result: { summary: string; issues?: Issue[] }, rebut = true): string {
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
    if (rebut) {
      parts.push(
        "If you believe the evaluation is mistaken or if you need to defend a design choice, call the eval_rebuttal tool with a concise rebuttal. Otherwise continue normally and fix the work.",
      )
    }
    return parts.join("\n")
  }

  export function followup(result: { summary: string; issues?: Issue[] }, rebuttal: string): string {
    const parts = [
      "The build agent submitted a rebuttal to your most recent failed evaluation.",
      "Review every rebuttal point carefully.",
      "If the rebuttal is correct, revise your verdict. If it is incorrect, keep the failure and explain the remaining issues.",
      "Your turn must end by calling eval_result again.",
      "",
      "## Previous Evaluation Summary",
      result.summary,
    ]
    if (result.issues?.length) {
      parts.push("", "## Previous Issues")
      parts.push(
        ...result.issues.map(
          (issue) => `- [${issue.severity}]${issue.file ? ` (${issue.file})` : ""}: ${issue.description}`,
        ),
      )
    }
    parts.push("", "## Build Rebuttal", rebuttal)
    return parts.join("\n")
  }

  async function review(input: {
    sessionID: SessionID
    model: { providerID: ProviderID; modelID: ModelID }
    prompt: string
  }) {
    await SessionPrompt.prompt({
      sessionID: input.sessionID,
      agent: "eval",
      model: input.model,
      parts: [{ type: "text", text: input.prompt }],
    })

    return parse([...MessageV2.stream(input.sessionID)].reverse())
  }

  export async function run(input: {
    sessionID: SessionID
    instruction: string
    model?: { providerID: ProviderID; modelID: ModelID }
    max?: number
    onAttempt?: (attempt: number, max: number) => void
    onResult?: (result: Result) => void
    onEval?: (sessionID: SessionID) => void | Promise<void>
    onBuild?: (sessionID: SessionID) => void | Promise<void>
    onRebuttal?: (sessionID: SessionID, round: number) => void | Promise<void>
    onReview?: (sessionID: SessionID, round: number) => void | Promise<void>
  }): Promise<Result> {
    const max = input.max ?? 5
    const rules: Permission.Ruleset = [
      { permission: "question", action: "deny", pattern: "*" },
      { permission: "plan_enter", action: "deny", pattern: "*" },
      { permission: "plan_exit", action: "deny", pattern: "*" },
    ]
    const msgs = await Session.messages({ sessionID: input.sessionID })
    const ctx = turn(msgs)
    const resolved = input.model ?? ctx?.model ?? (await Provider.defaultModel())

    const tracked: SessionID[] = []

    let last: Result = {
      pass: false,
      summary: "Eval did not complete",
      attempt: 0,
      sessionID: input.sessionID,
      sessions: tracked,
      round: 0,
      phase: "failed",
    }

    for (let attempt = 1; attempt <= max; attempt++) {
      input.onAttempt?.(attempt, max)
      log.info("eval attempt", { attempt, max })

      const msgs = await Session.messages({ sessionID: input.sessionID })
      const diffs = await SessionSummary.computeDiff({ messages: msgs }).catch(() => [])
      const hasDiff = diffs.length > 0
      const extra = hasDiff ? { files: diffs.map((d) => d.file), diff: patch(diffs) } : fallback(msgs)

      const evalSession = await Session.create({
        parentID: input.sessionID,
        title: `Eval attempt ${attempt}`,
        permission: rules,
      })

      tracked.push(evalSession.id)
      await input.onEval?.(evalSession.id)

      let round = 1
      let verdict = await review({
        sessionID: evalSession.id,
        model: resolved,
        prompt: compose(input.instruction, extra.diff, extra.files, hasDiff || !!extra.diff),
      })

      while (true) {
        last = {
          pass: verdict?.pass ?? false,
          summary: verdict?.summary ?? "Eval agent did not call eval_result",
          issues: verdict?.issues,
          attempt,
          sessionID: evalSession.id,
          sessions: tracked,
          round,
          phase: verdict?.pass ? "passed" : "failed",
          ...(round > 1 ? { rebutted: true } : {}),
        }

        input.onResult?.(last)

        if (last.pass) {
          log.info("eval passed", { attempt, round })
          return last
        }

        if (attempt >= max) {
          log.info("max eval iterations reached", { attempt, max })
          return last
        }

        log.info("eval failed, sending feedback to build", { attempt, round })
        await input.onBuild?.(input.sessionID)
        const build = await SessionPrompt.prompt({
          sessionID: input.sessionID,
          agent: ctx?.agent,
          model: ctx?.model ?? resolved,
          parts: [
            {
              type: "text",
              text: feedback(last, round <= MAX_REBUT),
              metadata: metadata({
                sessionId: evalSession.id,
                mode: "headless",
                policy: "rerun_on_accept",
                phase: "failed",
                round,
                summary: last.summary,
                pass: false,
                rebutted: round > 1,
              }),
            },
          ],
        })

        const root = await Session.messages({ sessionID: input.sessionID })
        const active = pending(root)
        await resolve(active?.part)
        const note = rebut(
          root
            .filter((msg) => msg.info.role === "assistant" && msg.info.parentID === active?.message.info.id)
            .flatMap((msg) => msg.parts),
        )
        if (!note || round > MAX_REBUT) break

        await input.onRebuttal?.(input.sessionID, round)
        round++
        await input.onReview?.(evalSession.id, round)
        verdict = await review({
          sessionID: evalSession.id,
          model: resolved,
          prompt: followup(last, note.content),
        })
      }
    }

    return last
  }
}
