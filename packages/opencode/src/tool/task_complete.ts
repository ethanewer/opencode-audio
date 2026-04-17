import z from "zod"
import { Tool } from "./tool"
import { Tmux } from "@/tmux/tmux"
import { Todo } from "../session/todo"
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

  export function confirm(sessionID: SessionID) {
    pending.set(sessionID, false)
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

function count(messages: MessageV2.WithParts[]) {
  let n = 0
  let first = ""
  for (const msg of messages) {
    if (msg.info.role !== "user") continue
    for (const part of msg.parts) {
      if (part.type !== "text") continue
      if ("synthetic" in part && part.synthetic) continue
      if ("ignored" in part && part.ignored) continue
      const text = part.text.trim()
      if (!text) continue
      n++
      if (n === 1) first = text
    }
  }
  return { n, first }
}

export const TaskCompleteTool = Tool.define("task_complete", {
  description: "Call this when the task is complete.",
  parameters: z.object({}),
  async execute(_params, ctx) {
    const sid = ctx.sessionID

    // If there are incomplete todos, bounce back before entering the confirmation flow
    const todos = Todo.get(sid)
    const incomplete = Todo.incomplete(todos)
    if (todos.length > 0 && incomplete.length > 0) {
      // Reset any pending confirmation so the double-confirm restarts cleanly
      pending.delete(sid)
      return {
        title: `${incomplete.length} incomplete todos`,
        metadata: { confirmed: false, todosRemaining: true },
        output: [
          "You still have incomplete items on your todo list:",
          "",
          Todo.incompleteList(todos),
          "",
          Todo.CONTINUE_HINT,
        ].join("\n"),
      }
    }

    if (pending.get(sid) === true) {
      pending.set(sid, false)
      return {
        title: "Task complete",
        metadata: { confirmed: true, todosRemaining: false },
        output: "Task confirmed complete.",
      }
    }

    pending.set(sid, true)
    const { n, first } = count(ctx.messages)
    let task = first || "N/A"
    if (n > 1) {
      const { Eval } = await import("../session/eval")
      task = (await Eval.extract(sid)) || task
    }
    const terminal = await Tmux.capture(sid)

    return {
      title: "Completion checklist",
      metadata: { confirmed: false, todosRemaining: false },
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
