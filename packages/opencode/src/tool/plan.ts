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
    const file = Session.plan(session)
    const rel = path.relative(Instance.worktree, file)
    const body = await Bun.file(file)
      .text()
      .then((x) => x.trim())
      .catch(() => "")
    if (!body) {
      throw new Error(`No finalized plan found at ${rel}. Write the plan to that file before calling plan_exit.`)
    }
    const mode = await target(ctx.sessionID, ctx.agent)
    const auto = process.env.OPENCODE_CLI_PLAN_AUTO_BUILD === "1"
    const model = await getLastModel(ctx.sessionID)

    if (!auto) {
      const answers = await Question.ask({
        sessionID: ctx.sessionID,
        questions: [
          {
            question: `Plan at ${rel} is complete. Would you like to switch to the ${mode} agent and start implementing?`,
            header: "Build Agent",
            options: [
              { label: "Yes", description: `Switch to ${mode} agent and start implementing the plan` },
              { label: "Keep planning", description: "Stay in plan mode and continue refining the plan" },
            ],
          },
        ],
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
      })

      const answer = answers[0]?.[0]?.trim()
      if (answer !== "Yes") {
        const text =
          !answer || answer === "Keep planning"
            ? "The user wants to stay in plan mode. Continue refining the plan."
            : ["The user wants to stay in plan mode and provided this feedback:", answer].join("\n\n")
        await followup(ctx, model, text)
        return {
          title: "Continuing in plan mode",
          output: text,
          metadata: { followup: true, handoff: false },
        }
      }
    }

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
        `Plan mode has ended. The plan at ${rel} has been approved. Switch to the ${mode} agent, you can now edit files, and execute the approved plan.`,
        `Plan file: ${file}`,
        [`## Approved Plan:`, body].join("\n"),
      ].join("\n\n"),
      synthetic: true,
    } satisfies MessageV2.TextPart)

    return {
      title: `Switching to ${mode} agent`,
      output: [
        auto
          ? `Plan approved automatically for this CLI run. Continue by executing the approved plan with the ${mode} agent.`
          : `User approved switching to ${mode} agent. Continue by executing the approved plan.`,
        `Plan file: ${file}`,
        [`## Approved Plan:`, body].join("\n"),
      ].join("\n\n"),
      metadata: { handoff: true, followup: false },
    }
  },
})

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
