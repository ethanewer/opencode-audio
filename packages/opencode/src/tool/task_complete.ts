import z from "zod"
import { Tool } from "./tool"
import { Todo } from "../session/todo"
import type { SessionID } from "../session/schema"
import type { MessageV2 } from "../session/message-v2"

// Per-session state:
//   undefined — task_complete has not yet been called
//   true      — task_complete was called and is awaiting the session-end eval
//   false     — eval flow has concluded for this session
//
// The build loop breaks out when `isConfirmed` returns true (pending === false).
// We flip pending from true to false inside TaskComplete.confirm, which is
// currently unused by the build flow — the build loop simply checks
// `isConfirmed`, and the prompt loop code treats our single call as a
// completion trigger. See src/session/prompt.ts for the loop behaviour.
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
    Todo.reset(sessionID)
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
  description:
    "Call this when you believe the task is complete. A separate evaluation agent will then verify your work in a fresh context and return feedback if any issues are found.",
  parameters: z.object({}),
  async execute(_params, ctx) {
    const sid = ctx.sessionID

    // Bounce if there are incomplete todos. Every todo must be completed or
    // cancelled before finishing.
    const todos = Todo.get(sid)
    const incomplete = Todo.incomplete(todos)
    if (todos.length > 0 && incomplete.length > 0) {
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

    // Mark confirmed so the build loop exits. Session-end wiring (run.ts) will
    // invoke the eval agent on the completed build session to verify the work.
    pending.set(sid, false)
    return {
      title: "Task complete",
      metadata: { confirmed: true, todosRemaining: false },
      output:
        "Task marked complete. An evaluation agent will now verify your work in a fresh context. If the evaluator finds issues, you will receive feedback and can continue to fix them.",
    }
  },
})
