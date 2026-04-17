import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import z from "zod"
import { Database, eq, asc } from "../storage/db"
import { TodoTable } from "./session.sql"

export namespace Todo {
  export const Info = z
    .object({
      content: z
        .string()
        .describe("Short, specific, actionable title for the task (one line, imperative phrasing)."),
      status: z
        .enum(["pending", "in_progress", "completed", "cancelled"])
        .describe(
          "Lifecycle state. pending = not yet started, in_progress = currently being worked on (only one at a time), completed = finished, cancelled = no longer needed.",
        ),
      notes: z
        .string()
        .describe(
          "Working notes for this todo. Always populate this field. " +
            "For pending: 1–3 sentences sketching what you plan to do. " +
            "For in_progress: 2–5 sentences covering your current hypothesis, what commands or edits you are about to run, and what outcome you expect. " +
            "For completed: 1–3 sentences summarising what you actually did, what you observed, and any new facts that might affect later todos. " +
            "For cancelled: 1 sentence explaining why it is no longer needed. " +
            "Write notes in natural prose; this field is where you think out loud between actions.",
        ),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: SessionID.zod,
        todos: z.array(Info),
      }),
    ),
  }

  // Notes are passed through tool output but not persisted to the DB (schema
  // does not have a column). We cache the most recent notes per session in
  // memory so TUI reads and task_complete messages can surface them.
  const notes = new Map<string, string[]>()

  export function update(input: { sessionID: SessionID; todos: Info[] }) {
    Database.transaction((db) => {
      db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
      if (input.todos.length === 0) {
        notes.delete(input.sessionID)
        return
      }
      db.insert(TodoTable)
        .values(
          input.todos.map((todo, position) => ({
            session_id: input.sessionID,
            content: todo.content,
            status: todo.status,
            position,
          })),
        )
        .run()
    })
    notes.set(
      input.sessionID,
      input.todos.map((t) => t.notes ?? ""),
    )
    Bus.publish(Event.Updated, input)
  }

  export function get(sessionID: SessionID): Info[] {
    const rows = Database.use((db) =>
      db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
    )
    const cached = notes.get(sessionID) ?? []
    return rows.map((row, i) => ({
      content: row.content,
      status: row.status as Info["status"],
      notes: cached[i] ?? "",
    }))
  }

  export function reset(sessionID: SessionID) {
    notes.delete(sessionID)
  }

  export function incomplete(todos: Info[]) {
    return todos.filter((t) => t.status === "pending" || t.status === "in_progress")
  }

  export const CONTINUE_HINT =
    "Complete or cancel each remaining todo before finishing the task. Do not ask the user what to do next — proceed with the next incomplete item now."

  export function incompleteList(todos: Info[]) {
    return todos
      .map((t, i) => {
        const note = t.notes?.trim() ? `\n   notes: ${t.notes.trim()}` : ""
        return `${i + 1}. [${t.status}] ${t.content}${note}`
      })
      .join("\n")
  }
}
