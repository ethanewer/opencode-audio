import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION_WRITE from "./todowrite.txt"
import { Todo } from "../session/todo"

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

    Todo.update({
      sessionID: ctx.sessionID,
      todos: params.todos,
    })
    const incomplete = Todo.incomplete(params.todos)
    const nudge =
      incomplete.length > 0
        ? "Todos updated. Continue with the next in_progress or pending item. Mark each todo `completed` or `cancelled` before calling task_complete."
        : "Todos updated. All items are completed or cancelled."
    return {
      title: `${incomplete.length} todos`,
      output: [JSON.stringify(params.todos, null, 2), "", nudge].join("\n"),
      metadata: {
        todos: params.todos,
      },
    }
  },
})
