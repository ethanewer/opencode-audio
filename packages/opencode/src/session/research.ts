import type { Complexity } from "./complexity"
import type { Tool } from "../tool/tool"
import { Session } from "."
import { Agent } from "../agent/agent"
import { SessionPrompt } from "./prompt"
import { MessageID } from "./schema"
import { MessageV2 } from "./message-v2"

function tasks(plan: string): { description: string; prompt: string }[] {
  const result: { description: string; prompt: string }[] = []
  const lower = plan.toLowerCase()

  result.push({
    description: "Explore codebase for plan context",
    prompt: `Explore the codebase to understand context for this implementation plan:\n\n${plan}\n\nFocus on:\n1. Existing patterns and conventions used in this project\n2. Related files and modules that might be affected\n3. Any existing similar implementations\n\nOutput a brief summary of relevant findings (max 500 words).\nDO NOT make any changes. Research only.`,
  })

  const mentions = (keywords: string[]) => keywords.some((k) => lower.includes(k))

  if (mentions(["test", "spec", "coverage", "validation"])) {
    result.push({
      description: "Analyze testing patterns",
      prompt: `Analyze the testing patterns in this codebase relevant to this plan:\n\n${plan}\n\nFocus on:\n1. Test file locations and naming conventions\n2. Testing frameworks and utilities used\n3. Existing test patterns to follow\n\nOutput a brief summary (max 300 words).\nDO NOT make any changes. Research only.`,
    })
  }

  if (mentions(["api", "endpoint", "integration", "webhook", "http", "route"])) {
    result.push({
      description: "Analyze API patterns",
      prompt: `Analyze API patterns in this codebase relevant to this plan:\n\n${plan}\n\nFocus on:\n1. API structure and routing patterns\n2. Request/response handling conventions\n3. Error handling patterns\n\nOutput a brief summary (max 300 words).\nDO NOT make any changes. Research only.`,
    })
  }

  return result
}

export async function research(
  ctx: Tool.Context,
  plan: string,
  _complexity: Complexity,
): Promise<string[]> {
  const agent = await Agent.get("explore")
  if (!agent) return []

  const model = await getModel(ctx)
  const items = tasks(plan)

  const results = await Promise.all(
    items.map(async (item) => {
      const session = await Session.create({
        parentID: ctx.sessionID,
        title: item.description + " (@explore research)",
        permission: [
          { permission: "task" as const, pattern: "*" as const, action: "deny" as const },
          { permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const },
          { permission: "speak" as const, pattern: "*" as const, action: "deny" as const },
        ],
      })

      try {
        const result = await SessionPrompt.prompt({
          messageID: MessageID.ascending(),
          sessionID: session.id,
          model,
          agent: "explore",
          parts: [{ type: "text", text: item.prompt }],
        })
        return result.parts.findLast((x) => x.type === "text")?.text ?? ""
      } catch {
        return ""
      }
    }),
  )

  return results.filter(Boolean)
}

async function getModel(ctx: Tool.Context) {
  try {
    const msg = MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
    if (msg.info.role === "assistant") {
      return { modelID: msg.info.modelID, providerID: msg.info.providerID }
    }
  } catch {}
  const { Provider } = await import("../provider/provider")
  return Provider.defaultModel()
}
