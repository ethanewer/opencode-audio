import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import z from "zod"
import { Database, eq, asc } from "../storage/db"
import { TodoTable } from "./session.sql"

export namespace Todo {
  export const Info = z
    .object({
      content: z.string().describe("Brief description of the task"),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]).describe("Current status of the task"),
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

  export function update(input: { sessionID: SessionID; todos: Info[] }) {
    Database.transaction((db) => {
      db.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
      if (input.todos.length === 0) return
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
    Bus.publish(Event.Updated, input)
  }

  export function get(sessionID: SessionID) {
    const rows = Database.use((db) =>
      db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
    )
    return rows.map((row) => ({
      content: row.content,
      status: row.status as Info["status"],
    }))
  }

  export function incomplete(todos: Info[]) {
    return todos.filter((t) => t.status === "pending" || t.status === "in_progress")
  }

  export const CONTINUE_HINT =
    "Complete or cancel each remaining todo before finishing the task. Do not ask the user what to do next — proceed with the next incomplete item now."

  export function incompleteList(todos: Info[]) {
    return todos.map((t, i) => `${i + 1}. [${t.status}] ${t.content}`).join("\n")
  }
}
