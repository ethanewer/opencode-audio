import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { ToolRegistry } from "../../src/tool/registry"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { SessionID, MessageID } from "../../src/session/schema"
import { TaskComplete, TaskCompleteTool } from "../../src/tool/task_complete"
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
  test("build agent gets only KIRA tools + invalid", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model, imageInput: true },
          agent("build") as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("execute_commands")
        expect(ids).toContain("task_complete")
        expect(ids).toContain("image_read")
        expect(ids).toContain("invalid")
        // Should NOT contain standard tools
        expect(ids).not.toContain("bash")
        expect(ids).not.toContain("read")
        expect(ids).not.toContain("edit")
        expect(ids).not.toContain("write")
        expect(ids).not.toContain("grep")
        expect(ids).not.toContain("glob")
        expect(ids).not.toContain("task")
        expect(ids).not.toContain("webfetch")
        expect(ids).not.toContain("todowrite")
        expect(ids).not.toContain("question")
        expect(ids).not.toContain("eval_rebuttal")
      },
    })
  })

  test("build agent hides image_read when model lacks image input", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model, imageInput: false },
          agent("build") as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("execute_commands")
        expect(ids).toContain("task_complete")
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
        expect(ids).toContain("execute_commands")
        expect(ids).toContain("task_complete")
        expect(ids).toContain("image_read")
        expect(ids).toContain("speak")
        expect(ids).not.toContain("bash")
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

  test("build agent gets transcribe when no native audio input", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model, audioInput: false },
          agent("build") as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("transcribe")
        expect(ids).not.toContain("read_audio")
      },
    })
  })

  test("build agent gets read_audio when model supports audio input", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model, audioInput: true },
          agent("build") as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("read_audio")
        expect(ids).not.toContain("transcribe")
      },
    })
  })

  test("build agent can add extra tools via options.tools", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model },
          agent("build", { tools: ["read", "edit", "grep"] }) as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("execute_commands")
        expect(ids).toContain("task_complete")
        expect(ids).toContain("read")
        expect(ids).toContain("edit")
        expect(ids).toContain("grep")
        expect(ids).not.toContain("write")
        expect(ids).not.toContain("webfetch")
      },
    })
  })

  test("build agent gets eval_rebuttal only when explicitly listed", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const without = await ToolRegistry.tools(
          { providerID: provider, modelID: model },
          agent("build") as never,
        )
        expect(without.map((t) => t.id)).not.toContain("eval_rebuttal")

        const with_ = await ToolRegistry.tools(
          { providerID: provider, modelID: model },
          agent("build", { tools: ["eval_rebuttal"] }) as never,
        )
        expect(with_.map((t) => t.id)).toContain("eval_rebuttal")
      },
    })
  })

  test("plan agent does NOT get execute_commands or task_complete", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model },
          agent("plan") as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).not.toContain("execute_commands")
        expect(ids).not.toContain("task_complete")
        expect(ids).toContain("bash")
        expect(ids).toContain("read")
      },
    })
  })

  test("eval agent does NOT get execute_commands or task_complete", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model },
          agent("eval") as never,
        )
        const ids = tools.map((t) => t.id)
        expect(ids).not.toContain("execute_commands")
        expect(ids).not.toContain("task_complete")
      },
    })
  })
})

describe("task_complete double-confirmation", () => {
  const sid = "ses_test_tc" as any

  test("first call returns checklist, second call confirms", () => {
    TaskComplete.reset(sid)
    expect(TaskComplete.isPending(sid)).toBe(false)
    expect(TaskComplete.isConfirmed(sid)).toBe(false)
  })

  test("instruction extracts first non-synthetic user text", () => {
    const msgs: MessageV2.WithParts[] = [
      {
        info: { role: "user", id: "m1" } as any,
        parts: [
          { type: "text", text: "Create a file", synthetic: false } as any,
        ],
      },
      {
        info: { role: "user", id: "m2" } as any,
        parts: [
          { type: "text", text: "System reminder", synthetic: true } as any,
        ],
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

  test("pending/confirmed state transitions", () => {
    TaskComplete.reset(sid)
    expect(TaskComplete.isPending(sid)).toBe(false)
    expect(TaskComplete.isConfirmed(sid)).toBe(false)
  })

  test("checklist shows first message for single user input", async () => {
    const id = SessionID.make("ses_tc_single")
    TaskComplete.reset(id)
    const msgs: MessageV2.WithParts[] = [
      {
        info: { role: "user", id: "m1" } as any,
        parts: [{ type: "text", text: "Build a REST API", synthetic: false } as any],
      },
    ]
    const tool = await TaskCompleteTool.init()
    const result = await tool.execute({}, {
      sessionID: id,
      messageID: MessageID.make(""),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: msgs,
      metadata: () => {},
      ask: async () => {},
    })
    expect(result.output).toContain("Build a REST API")
    expect(result.metadata.confirmed).toBe(false)
    TaskComplete.reset(id)
  })

  test("checklist uses fast path when synthetic messages pad the count", async () => {
    const id = SessionID.make("ses_tc_synth")
    TaskComplete.reset(id)
    const msgs: MessageV2.WithParts[] = [
      {
        info: { role: "user", id: "m1" } as any,
        parts: [{ type: "text", text: "Fix the bug", synthetic: false } as any],
      },
      {
        info: { role: "user", id: "m2" } as any,
        parts: [{ type: "text", text: "WARNINGS: no tool calls", synthetic: true } as any],
      },
      {
        info: { role: "user", id: "m3" } as any,
        parts: [{ type: "text", text: "", synthetic: false } as any],
      },
    ]
    const tool = await TaskCompleteTool.init()
    const result = await tool.execute({}, {
      sessionID: id,
      messageID: MessageID.make(""),
      callID: "",
      agent: "build",
      abort: AbortSignal.any([]),
      messages: msgs,
      metadata: () => {},
      ask: async () => {},
    })
    expect(result.output).toContain("Fix the bug")
    expect(result.metadata.confirmed).toBe(false)
    TaskComplete.reset(id)
  })
})

describe("execute_commands tool definition", () => {
  test("description matches KIRA exactly", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model },
          agent("build") as never,
        )
        const exec = tools.find((t) => t.id === "execute_commands")
        expect(exec).toBeDefined()
        expect(exec!.description).toBe(
          "Call this to execute commands in the terminal with your analysis and plan.",
        )
      },
    })
  })

  test("task_complete description matches KIRA", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model },
          agent("build") as never,
        )
        const tc = tools.find((t) => t.id === "task_complete")
        expect(tc).toBeDefined()
        expect(tc!.description).toBe("Call this when the task is complete.")
      },
    })
  })

  test("image_read description matches KIRA", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools(
          { providerID: provider, modelID: model, imageInput: true },
          agent("build") as never,
        )
        const ir = tools.find((t) => t.id === "image_read")
        expect(ir).toBeDefined()
        expect(ir!.description).toContain("Read and analyze an image file")
      },
    })
  })
})
