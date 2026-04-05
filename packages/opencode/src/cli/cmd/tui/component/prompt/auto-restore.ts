import type { Part, Session, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { Permission } from "@/permission"

type Input = {
  msg?: UserMessage
  parts: Part[]
  session?: Session
  status: SessionStatus
}

type Result = {
  agent: string
  phase?: "idle" | "plan" | "build"
}

function auto(session?: Session) {
  if (!session || session.parentID) return false
  return Permission.evaluate("tui_auto", "*", session.permission ?? []).action === "deny"
}

function handoff(parts: Part[]) {
  return parts.some((part) => {
    if (part.type !== "text") return false
    const plan = part.metadata?.plan
    if (!plan || typeof plan !== "object") return false
    return (plan as Record<string, unknown>).handoff === true
  })
}

function phase(msg: UserMessage, parts: Part[], status: SessionStatus) {
  if (status.type === "idle") return "idle"
  if (handoff(parts)) return "build"
  return msg.agent.replace(/^voice-/, "") === "build" ? "build" : "plan"
}

export function resolve(input: Input): Result | undefined {
  const msg = input.msg
  if (!msg?.agent) return

  const agent = msg.agent.replace(/^voice-/, "")
  if (!auto(input.session)) return { agent }
  return {
    agent: "auto",
    phase: phase(msg, input.parts, input.status),
  }
}
