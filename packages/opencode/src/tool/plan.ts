import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Agent } from "../agent/agent"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { type SessionID, MessageID, PartID } from "../session/schema"
import { detectComplexity, type Complexity } from "../session/complexity"
import { research } from "../session/research"
import { assemblePrompt } from "../session/prompt-assembly"
import EXIT_DESCRIPTION from "./plan-exit.txt"

async function getLastModel(sessionID: SessionID) {
  const msgs = await Session.messages({ sessionID })
  for (let i = msgs.length - 1; i >= 0; i--) {
    const item = msgs[i]
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}

function isPlan(agent: string) {
  return agent === "plan" || agent === "voice-plan"
}

function build(agent: string) {
  return agent === "voice-plan" ? "voice-build" : "build"
}

async function target(sessionID: SessionID, agent: string) {
  const msgs = await Session.messages({ sessionID })
  let seen = false
  for (let i = msgs.length - 1; i >= 0; i--) {
    const item = msgs[i]
    if (item.info.role !== "user") continue
    if (!seen) {
      if (isPlan(item.info.agent)) {
        seen = true
      }
      continue
    }
    if (isPlan(item.info.agent)) continue
    const info = await Agent.get(item.info.agent).catch(() => undefined)
    if (info && info.mode !== "subagent") return info.name
  }
  return build(agent)
}

async function followup(ctx: Tool.Context, model: Awaited<ReturnType<typeof getLastModel>>, text: string) {
  const msg: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: ctx.sessionID,
    role: "user",
    time: {
      created: Date.now(),
    },
    agent: ctx.agent,
    model,
  }
  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID: ctx.sessionID,
    type: "text",
    text,
  } satisfies MessageV2.TextPart)
}

async function writeFile(filepath: string, content: string) {
  const { mkdir } = await import("fs/promises")
  await mkdir(path.dirname(filepath), { recursive: true })
  await Bun.write(filepath, content)
}

function parseComplexity(answer: string): Complexity | undefined {
  if (!answer.startsWith("Yes")) return undefined
  if (answer.includes("research")) return "complex"
  return "simple"
}

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    if (!isPlan(ctx.agent)) {
      throw new Error(
        "The plan_exit tool can only be used while in plan mode. If the user already approved the plan, continue implementation.",
      )
    }

    const session = await Session.get(ctx.sessionID)
    const planFile = Session.plan(session)
    const planRel = path.relative(Instance.worktree, planFile)
    const body = await Bun.file(planFile)
      .text()
      .then((x) => x.trim())
      .catch(() => "")
    if (!body) {
      throw new Error(`No finalized plan found at ${planRel}. Write the plan to that file before calling plan_exit.`)
    }

    const mode = await target(ctx.sessionID, ctx.agent)
    const auto = process.env.OPENCODE_CLI_PLAN_AUTO_BUILD === "1"
    const model = await getLastModel(ctx.sessionID)
    const detected = detectComplexity(body)

    let complexity: Complexity = detected

    if (!auto) {
      const result = await Question.ask({
        sessionID: ctx.sessionID,
        questions: [
          {
            question:
              ctx.agent === "voice-plan"
                ? `Plan is complete. Say yes to approve, research to explore the codebase first, or give feedback to keep planning.`
                : `Plan at ${planRel} is complete. Approve to start implementing, or keep planning.`,
            header: "Approve Plan",
            options: [
              { label: "Yes", description: "Approve and start building" },
              { label: "Yes (research)", description: "Approve with codebase research first" },
              { label: "Keep planning", description: "Continue refining the plan" },
            ],
          },
        ],
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
      })

      const answer = result.answers[0]?.[0]?.trim() ?? ""

      if (answer.startsWith("Yes") && result.context) {
        const text = [
          "The user wants to stay in plan mode and provided this feedback:",
          result.context,
        ].join("\n\n")
        await followup(ctx, model, text)
        return {
          title: "Continuing in plan mode",
          output: text,
          metadata: { followup: true, handoff: false },
        }
      }

      const parsed = parseComplexity(answer)
      if (!parsed) {
        const parts: string[] = []
        if (!answer || answer === "Keep planning") {
          parts.push("The user wants to stay in plan mode. Continue refining the plan.")
        } else {
          parts.push("The user wants to stay in plan mode and provided this feedback:", answer)
        }
        if (result.context) {
          parts.push("\nAdditional context from the user: " + result.context)
        }
        const text = parts.join("\n\n")
        await followup(ctx, model, text)
        return {
          title: "Continuing in plan mode",
          output: text,
          metadata: { followup: true, handoff: false },
        }
      }

      complexity = parsed
    }

    // --- Pipeline: research + assembly + handoff ---

    const promptFile = Session.buildPrompt(session)
    const promptRel = path.relative(Instance.worktree, promptFile)

    let findings: string[] = []
    if (complexity === "complex") {
      findings = await research(ctx, body, complexity)
    }

    const prompt = assemblePrompt(body, findings)
    await writeFile(promptFile, prompt)

    return handoff(ctx, mode, model, promptFile, promptRel, prompt, auto)
  },
})

async function handoff(
  ctx: Tool.Context,
  mode: string,
  model: Awaited<ReturnType<typeof getLastModel>>,
  promptFile: string,
  promptRel: string,
  prompt: string,
  auto: boolean,
) {
  const userMsg: MessageV2.User = {
    id: MessageID.ascending(),
    sessionID: ctx.sessionID,
    role: "user",
    time: {
      created: Date.now(),
    },
    agent: mode,
    model,
  }
  await Session.updateMessage(userMsg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: userMsg.id,
    sessionID: ctx.sessionID,
    type: "text",
    text: [
      `Plan mode has ended. The build prompt at ${promptRel} has been approved. Switch to the ${mode} agent, you can now edit files, and execute the approved prompt.`,
      `Prompt file: ${promptFile}`,
      ["## Approved Build Prompt:", prompt].join("\n"),
    ].join("\n\n"),
    synthetic: true,
  } satisfies MessageV2.TextPart)

  return {
    title: `Switching to ${mode} agent`,
    output: [
      auto
        ? `Prompt approved automatically for this CLI run. Continue by executing the approved prompt with the ${mode} agent.`
        : `User approved switching to ${mode} agent. Continue by executing the approved prompt.`,
      `Prompt file: ${promptFile}`,
      ["## Approved Build Prompt:", prompt].join("\n"),
    ].join("\n\n"),
    metadata: { handoff: true, followup: false },
  }
}

/*
export const PlanEnterTool = Tool.define("plan_enter", {
  description: ENTER_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = path.relative(Instance.worktree, Session.plan(session))

    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: [
        {
          question: `Would you like to switch to the plan agent and create a plan saved to ${plan}?`,
          header: "Plan Mode",
          custom: false,
          options: [
            { label: "Yes", description: "Switch to plan agent for research and planning" },
            { label: "No", description: "Stay with build agent to continue making changes" },
          ],
        },
      ],
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const answer = answers[0]?.[0]

    if (answer === "No") throw new Question.RejectedError()

    const model = await getLastModel(ctx.sessionID)

    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: ctx.sessionID,
      role: "user",
      time: {
        created: Date.now(),
      },
      agent: "plan",
      model,
    }
    await Session.updateMessage(userMsg)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: "User has requested to enter plan mode. Switch to plan mode and begin planning.",
      synthetic: true,
    } satisfies MessageV2.TextPart)

    return {
      title: "Switching to plan agent",
      output: `User confirmed to switch to plan mode. A new message has been created to switch you to plan mode. The plan file will be at ${plan}. Begin planning.`,
      metadata: {},
    }
  },
})
*/
