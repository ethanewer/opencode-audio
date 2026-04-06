import z from "zod"
import { Tool } from "./tool"
import { Tmux } from "@/tmux/tmux"
import type { SessionID } from "../session/schema"
import type { MessageV2 } from "../session/message-v2"

const pending = new Map<string, boolean>()

export namespace TaskComplete {
  export function isPending(sessionID: SessionID) {
    return pending.get(sessionID) === true
  }

  export function isConfirmed(sessionID: SessionID) {
    return pending.get(sessionID) === false
  }

  export function reset(sessionID: SessionID) {
    pending.delete(sessionID)
  }

  export function instruction(messages: MessageV2.WithParts[]) {
    for (const msg of messages) {
      if (msg.info.role !== "user") continue
      for (const part of msg.parts) {
        if (part.type === "text" && !part.synthetic && part.text.trim()) return part.text.trim()
      }
    }
    return "N/A"
  }
}

export const TaskCompleteTool = Tool.define("task_complete", {
  description: "Call this when the task is complete.",
  parameters: z.object({}),
  async execute(_params, ctx) {
    const sid = ctx.sessionID
    if (pending.get(sid) === true) {
      pending.set(sid, false)
      return {
        title: "Task complete",
        metadata: { confirmed: true },
        output: "Task confirmed complete.",
      }
    }

    pending.set(sid, true)
    const task = TaskComplete.instruction(ctx.messages)
    const terminal = await Tmux.capture(sid)

    return {
      title: "Completion checklist",
      metadata: { confirmed: false },
      output: [
        `Original task:\n${task}`,
        "",
        `Current terminal state:\n${terminal}`,
        "",
        "Are you sure you want to mark the task as complete?",
        "",
        "[!] Checklist",
        "- Does your solution meet the requirements in the original task above? [TODO/DONE]",
        "- Does your solution account for potential changes in numeric values, array sizes, file contents, or configuration parameters? [TODO/DONE]",
        "- Have you verified your solution from the all perspectives of a test engineer, a QA engineer, and the user who requested this task?",
        "  - test engineer [TODO/DONE]",
        "  - QA engineer [TODO/DONE]",
        "  - user who requested this task [TODO/DONE]",
        "",
        "After this point, solution grading will begin and no further edits will be possible. If everything looks good, call task_complete tool again.",
      ].join("\n"),
    }
  },
})
