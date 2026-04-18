import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { SessionID, MessageID } from "../../src/session/schema"
import { TaskComplete, TaskCompleteTool } from "../../src/tool/task_complete"
import { Todo } from "../../src/session/todo"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

const provider = ProviderID.make("test")
const model = ModelID.make("test-model")

function agent(name: string, opts: Record<string, unknown> = {}) {
  return {
    name,
    mode: "primary" as const,
    permission: [],
    options: opts,
  }
}

describe("kira tool filtering", () => {
  test("build agent gets registered tools", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model, imageInput: true },
          agent("build") as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("shell")
        expect(ids).toContain("task_complete")
        expect(ids).toContain("read")
        expect(ids).toContain("write")
        expect(ids).toContain("edit")
        expect(ids).toContain("invalid")
        expect(ids).not.toContain("bash")
        expect(ids).not.toContain("execute_commands")
        expect(ids).not.toContain("grep")
        expect(ids).not.toContain("glob")
        expect(ids).toContain("webfetch")
        expect(ids).not.toContain("image_read")
      },
    })
  })

  test("voice-build agent gets KIRA tools plus speak", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model, imageInput: true, audioOutput: false },
          agent("voice-build") as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("shell")
        expect(ids).toContain("task_complete")
        expect(ids).toContain("read")
        expect(ids).toContain("speak")
        expect(ids).not.toContain("bash")
        expect(ids).not.toContain("execute_commands")
        expect(ids).not.toContain("image_read")
      },
    })
  })

  test("voice-build agent hides speak when model has native audio output", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model, imageInput: true, audioOutput: true },
          agent("voice-build") as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).not.toContain("speak")
      },
    })
  })

  test("plan_exit only included for plan agent in CLI mode", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const saved = process.env["OPENCODE_CLIENT"]
        process.env["OPENCODE_CLIENT"] = "cli"
        try {
          const plan = await ToolRegistry.tools({ providerID: provider, modelID: model }, agent("plan") as never)
          expect(plan.map((t) => t.id)).toContain("plan_exit")
          expect(plan.map((t) => t.id)).toContain("read")

          const build = await ToolRegistry.tools({ providerID: provider, modelID: model }, agent("build") as never)
          expect(build.map((t) => t.id)).not.toContain("plan_exit")
        } finally {
          if (saved === undefined) delete process.env["OPENCODE_CLIENT"]
          else process.env["OPENCODE_CLIENT"] = saved
        }
      },
    })
  })

  test("eval agent gets eval_result", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: provider, modelID: model }, agent("eval") as never)
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("eval_result")
        expect(ids).toContain("read")
      },
    })
  })
})

describe("task_complete state helpers", () => {
  const sid = "ses_test_tc" as any

  test("initial state: not pending, not confirmed", () => {
    TaskComplete.reset(sid)
    expect(TaskComplete.isPending(sid)).toBe(false)
    expect(TaskComplete.isConfirmed(sid)).toBe(false)
  })

  test("instruction extracts first non-synthetic user text", () => {
    const msgs: MessageV2.WithParts[] = [
      {
        info: { role: "user", id: "m1" } as any,
        parts: [{ type: "text", text: "Create a file", synthetic: false } as any],
      },
      {
        info: { role: "user", id: "m2" } as any,
        parts: [{ type: "text", text: "System reminder", synthetic: true } as any],
      },
    ]
    expect(TaskComplete.instruction(msgs)).toBe("Create a file")
  })

  test("instruction returns N/A when no user text found", () => {
    const msgs: MessageV2.WithParts[] = [
      {
        info: { role: "assistant", id: "m1" } as any,
        parts: [{ type: "text", text: "response" } as any],
      },
    ]
    expect(TaskComplete.instruction(msgs)).toBe("N/A")
  })
})

describe("task_complete todo integration", () => {
  function ctx(sid: SessionID) {
    const msgs: MessageV2.WithParts[] = [
      {
        info: { role: "user", id: "m1" } as any,
        parts: [{ type: "text", text: "Do something", synthetic: false } as any],
      },
    ]
    return {
      sessionID: sid,
      messageID: MessageID.make(""),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: msgs,
      metadata: () => {},
      ask: async () => {},
    }
  }

  test("bounces back when incomplete todos exist", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id
        TaskComplete.reset(sid)
        Todo.update({
          sessionID: sid,
          todos: [
            { content: "Step 1", status: "completed", notes: "done" },
            { content: "Step 2", status: "in_progress", notes: "working" },
            { content: "Step 3", status: "pending", notes: "todo" },
          ],
        })
        const tool = await TaskCompleteTool.init()
        const result = await tool.execute({}, ctx(sid))
        expect(result.metadata.todosRemaining).toBe(true)
        expect(result.metadata.confirmed).toBe(false)
        expect(result.output).toContain("incomplete items")
        expect(result.output).toContain("Step 2")
        expect(result.output).toContain("Step 3")
        // pending state should NOT be set
        expect(TaskComplete.isPending(sid)).toBe(false)
        expect(TaskComplete.isConfirmed(sid)).toBe(false)
        Todo.update({ sessionID: sid, todos: [] })
        TaskComplete.reset(sid)
      },
    })
  })

  test("single call confirms when all todos are completed", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id
        TaskComplete.reset(sid)
        Todo.update({
          sessionID: sid,
          todos: [
            { content: "Step 1", status: "completed", notes: "done" },
            { content: "Step 2", status: "completed", notes: "done" },
          ],
        })
        const tool = await TaskCompleteTool.init()
        const r1 = await tool.execute({}, ctx(sid))
        expect(r1.metadata.todosRemaining).toBe(false)
        expect(r1.metadata.confirmed).toBe(true)
        expect(TaskComplete.isConfirmed(sid)).toBe(true)
        Todo.update({ sessionID: sid, todos: [] })
        TaskComplete.reset(sid)
      },
    })
  })

  test("single call confirms with no todos at all", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id
        TaskComplete.reset(sid)
        // No todos written — single call should confirm
        const tool = await TaskCompleteTool.init()
        const r1 = await tool.execute({}, ctx(sid))
        expect(r1.metadata.todosRemaining).toBe(false)
        expect(r1.metadata.confirmed).toBe(true)
        expect(TaskComplete.isConfirmed(sid)).toBe(true)
        TaskComplete.reset(sid)
      },
    })
  })

  test("bounce on incomplete todos, then later confirm after completing them", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id
        TaskComplete.reset(sid)
        const tool = await TaskCompleteTool.init()
        // Model has an incomplete todo and calls task_complete — should bounce
        Todo.update({
          sessionID: sid,
          todos: [{ content: "New task", status: "in_progress", notes: "still working on the fix" }],
        })
        const r1 = await tool.execute({}, ctx(sid))
        expect(r1.metadata.todosRemaining).toBe(true)
        expect(r1.metadata.confirmed).toBe(false)
        expect(r1.output).toContain("incomplete items")
        expect(TaskComplete.isConfirmed(sid)).toBe(false)
        // Model completes the todo and calls again — should confirm
        Todo.update({
          sessionID: sid,
          todos: [{ content: "New task", status: "completed", notes: "fixed" }],
        })
        const r2 = await tool.execute({}, ctx(sid))
        expect(r2.metadata.confirmed).toBe(true)
        expect(TaskComplete.isConfirmed(sid)).toBe(true)
        Todo.update({ sessionID: sid, todos: [] })
        TaskComplete.reset(sid)
      },
    })
  })

  test("cancelled todos do not block completion", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const sid = session.id
        TaskComplete.reset(sid)
        Todo.update({
          sessionID: sid,
          todos: [
            { content: "Done task", status: "completed", notes: "finished" },
            { content: "Skipped task", status: "cancelled", notes: "not needed" },
          ],
        })
        const tool = await TaskCompleteTool.init()
        const r1 = await tool.execute({}, ctx(sid))
        // cancelled is not pending/in_progress, so should NOT bounce
        expect(r1.metadata.todosRemaining).toBe(false)
        expect(r1.metadata.confirmed).toBe(true)
        Todo.update({ sessionID: sid, todos: [] })
        TaskComplete.reset(sid)
      },
    })
  })
})

describe("shell tool definition", () => {
  test("shell tool is registered and describes itself as interactive", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: provider, modelID: model }, agent("build") as never)
        const sh = tools.find((t) => t.id === "shell")
        expect(sh).toBeDefined()
        expect(sh!.description).toContain("Interactive shell")
        expect(sh!.description).toContain("persistent")
        expect(sh!.description).toContain("reset")
      },
    })
  })

  test("task_complete description mentions eval verification", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ providerID: provider, modelID: model }, agent("build") as never)
        const tc = tools.find((t) => t.id === "task_complete")
        expect(tc).toBeDefined()
        expect(tc!.description).toContain("evaluation agent")
        expect(tc!.description).toContain("fresh context")
      },
    })
  })
})
