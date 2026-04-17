import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

function validate(todos: Todo.Info[]) {
  const errors: string[] = []
  const active = todos.filter((t) => t.status === "in_progress")
  if (active.length > 1) {
    errors.push(
      `At most one todo may be in_progress at a time. Currently ${active.length} are in_progress: ${active.map((t) => JSON.stringify(t.content)).join(", ")}.`,
    )
  }
  todos.forEach((t, i) => {
    if (!t.content?.trim()) {
      errors.push(`Todo #${i + 1} is missing a content title.`)
    }
    const notesLen = (t.notes ?? "").trim().length
    if (notesLen === 0) {
      errors.push(
        `Todo #${i + 1} (${JSON.stringify(t.content)}) is missing notes. Populate notes with your plan/observations — it must never be empty.`,
      )
    } else {
      // Cancelled todos can have a very short "why" (e.g. "not needed"),
      // everything else should have at least one short sentence.
      const min = t.status === "cancelled" ? 6 : 12
      if (notesLen < min) {
        errors.push(
          `Todo #${i + 1} (${JSON.stringify(t.content)}) has notes that are too short (${notesLen} chars). Write at least 1 full sentence describing your plan or observation.`,
        )
      }
    }
  })
  return errors
}

export const TodoWriteTool = Tool.define("todowrite", {
  description: DESCRIPTION_WRITE,
  parameters: z.object({
    todos: z.array(z.object(Todo.Info.shape)).describe("The updated todo list"),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "todowrite",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })

    const errors = validate(params.todos)
    if (errors.length > 0) {
      return {
        title: "todowrite rejected",
        output: [
          "Your todowrite call was rejected. Fix the following problems and call todowrite again:",
          ...errors.map((e) => `- ${e}`),
          "",
          "Reminder: every todo must have a non-empty notes field. Notes are short working prose (the plan when pending/in_progress, the observation when completed). Do not leave notes blank.",
        ].join("\n"),
        metadata: {
          rejected: true,
          errors,
          todos: params.todos,
        },
      }
    }

    Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })
    const incomplete = Todo.incomplete(params.todos)
    const nudge =
      incomplete.length > 0
        ? "Todos updated. Continue with the next in_progress or pending item. Keep notes current as you learn. Mark each todo `completed` or `cancelled` before calling task_complete."
        : "Todos updated. All items are completed or cancelled. You may now call task_complete if you are confident the task is done."
    return {
      title: `${incomplete.length} todos`,
      output: [JSON.stringify(params.todos, null, 2), "", nudge].join("\n"),
      metadata: {
        rejected: false,
        errors: [] as string[],
        todos: params.todos,
      },
    }
  },
})
