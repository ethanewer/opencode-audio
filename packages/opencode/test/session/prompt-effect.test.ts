import { NodeFileSystem } from "@effect/platform-node"
import { expect, spyOn } from "bun:test"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import z from "zod"
import type { Agent } from "../../src/agent/agent"
import { Agent as AgentSvc } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { Command } from "../../src/command"
import { Config } from "../../src/config/config"
import { FileTime } from "../../src/file/time"
import { LSP } from "../../src/lsp"
import { MCP } from "../../src/mcp"
import { Permission } from "../../src/permission"
import { Plugin } from "../../src/plugin"
import { Question } from "../../src/question"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { LLM } from "../../src/session/llm"
import { MessageV2 } from "../../src/session/message-v2"
import { AppFileSystem } from "../../src/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { Eval } from "../../src/session/eval"
import { Todo } from "../../src/session/todo"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { SessionStatus } from "../../src/session/status"
import { Shell } from "../../src/shell/shell"
import { Snapshot } from "../../src/snapshot"
import { TaskTool } from "../../src/tool/task"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Log } from "../../src/util/log"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance, provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"

Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

function defer<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function withSh<A, E, R>(fx: () => Effect.Effect<A, E, R>) {
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const prev = process.env.SHELL
      process.env.SHELL = "/bin/sh"
      Shell.preferred.reset()
      return prev
    }),
    () => fx(),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.preferred.reset()
      }),
  )
}

function toolPart(parts: MessageV2.Part[]) {
  return parts.find((part): part is MessageV2.ToolPart => part.type === "tool")
}

type CompletedToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateCompleted }
type ErrorToolPart = MessageV2.ToolPart & { state: MessageV2.ToolStateError }

function completedTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("completed")
  return part?.state.status === "completed" ? (part as CompletedToolPart) : undefined
}

function errorTool(parts: MessageV2.Part[]) {
  const part = toolPart(parts)
  expect(part?.state.status).toBe("error")
  return part?.state.status === "error" ? (part as ErrorToolPart) : undefined
}

const mcp = Layer.succeed(
  MCP.Service,
  MCP.Service.of({
    status: () => Effect.succeed({}),
    clients: () => Effect.succeed({}),
    tools: () => Effect.succeed({}),
    prompts: () => Effect.succeed({}),
    resources: () => Effect.succeed({}),
    add: () => Effect.succeed({ status: { status: "disabled" as const } }),
    connect: () => Effect.void,
    disconnect: () => Effect.void,
    getPrompt: () => Effect.succeed(undefined),
    readResource: () => Effect.succeed(undefined),
    startAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    authenticate: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    finishAuth: () => Effect.die("unexpected MCP auth in prompt-effect tests"),
    removeAuth: () => Effect.void,
    supportsOAuth: () => Effect.succeed(false),
    hasStoredTokens: () => Effect.succeed(false),
    getAuthStatus: () => Effect.succeed("not_authenticated" as const),
  }),
)

const lsp = Layer.succeed(
  LSP.Service,
  LSP.Service.of({
    init: () => Effect.void,
    status: () => Effect.succeed([]),
    hasClients: () => Effect.succeed(false),
    touchFile: () => Effect.void,
    diagnostics: () => Effect.succeed({}),
    hover: () => Effect.succeed(undefined),
    definition: () => Effect.succeed([]),
    references: () => Effect.succeed([]),
    implementation: () => Effect.succeed([]),
    documentSymbol: () => Effect.succeed([]),
    workspaceSymbol: () => Effect.succeed([]),
    prepareCallHierarchy: () => Effect.succeed([]),
    incomingCalls: () => Effect.succeed([]),
    outgoingCalls: () => Effect.succeed([]),
  }),
)

const filetime = Layer.succeed(
  FileTime.Service,
  FileTime.Service.of({
    read: () => Effect.void,
    get: () => Effect.succeed(undefined),
    assert: () => Effect.void,
    withLock: (_filepath, fn) => Effect.promise(fn),
  }),
)

const status = SessionStatus.layer.pipe(Layer.provideMerge(Bus.layer))
const infra = Layer.mergeAll(NodeFileSystem.layer, CrossSpawnSpawner.defaultLayer)
function makeHttp() {
  const deps = Layer.mergeAll(
    Session.defaultLayer,
    Snapshot.defaultLayer,
    LLM.defaultLayer,
    AgentSvc.defaultLayer,
    Command.defaultLayer,
    Permission.layer,
    Question.layer,
    Plugin.defaultLayer,
    Config.defaultLayer,
    filetime,
    lsp,
    mcp,
    AppFileSystem.defaultLayer,
    status,
  ).pipe(Layer.provideMerge(infra))
  const registry = ToolRegistry.layer.pipe(Layer.provideMerge(deps))
  const trunc = Truncate.layer.pipe(Layer.provideMerge(deps))
  const proc = SessionProcessor.layer.pipe(Layer.provideMerge(deps))
  const compact = SessionCompaction.layer.pipe(Layer.provideMerge(proc), Layer.provideMerge(deps))
  return Layer.mergeAll(
    TestLLMServer.layer,
    SessionPrompt.layer.pipe(
      Layer.provideMerge(compact),
      Layer.provideMerge(proc),
      Layer.provideMerge(registry),
      Layer.provideMerge(trunc),
      Layer.provideMerge(deps),
    ),
  )
}

const it = testEffect(makeHttp())
const unix = process.platform !== "win32" ? it.live : it.live.skip

// Config that registers a custom "test" provider with a "test-model" model
// so Provider.getModel("test", "test-model") succeeds inside the loop.
const cfg = {
  provider: {
    test: {
      name: "Test",
      id: "test",
      env: [],
      npm: "@ai-sdk/openai-compatible",
      models: {
        "test-model": {
          id: "test-model",
          name: "Test Model",
          attachment: false,
          reasoning: false,
          temperature: false,
          tool_call: true,
          release_date: "2025-01-01",
          limit: { context: 100000, output: 10000 },
          cost: { input: 0, output: 0 },
          options: {},
        },
      },
      options: {
        apiKey: "test-key",
        baseURL: "http://localhost:1/v1",
      },
    },
  },
}

function providerCfg(url: string) {
  return {
    ...cfg,
    provider: {
      ...cfg.provider,
      test: {
        ...cfg.provider.test,
        options: {
          ...cfg.provider.test.options,
          baseURL: url,
        },
      },
    },
  }
}

const user = Effect.fn("test.user")(function* (sessionID: SessionID, text: string) {
  const session = yield* Session.Service
  const msg = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
})

const seed = Effect.fn("test.seed")(function* (sessionID: SessionID, opts?: { finish?: string }) {
  const session = yield* Session.Service
  const msg = yield* user(sessionID, "hello")
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: msg.id,
    sessionID,
    mode: "build",
    agent: "build",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
    ...(opts?.finish ? { finish: opts.finish } : {}),
  }
  yield* session.updateMessage(assistant)
  yield* session.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID,
    type: "text",
    text: "hi there",
  })
  return { user: msg, assistant }
})

const addSubtask = (sessionID: SessionID, messageID: MessageID, model = ref) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    yield* session.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "subtask",
      prompt: "look into the cache key path",
      description: "inspect bug",
      agent: "general",
      model,
    })
  })

const boot = Effect.fn("test.boot")(function* (input?: { title?: string }) {
  const prompt = yield* SessionPrompt.Service
  const sessions = yield* Session.Service
  const chat = yield* sessions.create(input ?? { title: "Pinned" })
  return { prompt, sessions, chat }
})

// Loop semantics

it.live("loop exits immediately when last assistant has stop finish", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* seed(chat.id, { finish: "stop" })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") expect(result.info.finish).toBe("stop")
      expect(yield* llm.calls).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop calls LLM and returns assistant message", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: chat.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.text("world")
      yield* llm.text("world")
      yield* llm.text("world")
      yield* llm.text("world")
      yield* llm.text("world")
      yield* llm.text("world")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      const parts = result.parts.filter((p) => p.type === "text")
      expect(parts.some((p) => p.type === "text" && p.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(6)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop returns assistant text through local provider", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const session = yield* Effect.promise(() =>
        Session.create({
          title: "Prompt provider",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )

      yield* Effect.promise(() =>
        SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello" }],
        }),
      )

      yield* llm.text("world")
      yield* llm.text("world")
      yield* llm.text("world")
      yield* llm.text("world")
      yield* llm.text("world")
      yield* llm.text("world")

      const result = yield* Effect.promise(() => SessionPrompt.loop({ sessionID: session.id }))
      expect(result.info.role).toBe("assistant")
      expect(result.parts.some((part) => part.type === "text" && part.text === "world")).toBe(true)
      expect(yield* llm.hits).toHaveLength(6)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("static loop consumes queued replies across turns", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const session = yield* Effect.promise(() =>
        Session.create({
          title: "Prompt provider turns",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        }),
      )

      yield* Effect.promise(() =>
        SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello one" }],
        }),
      )

      yield* llm.text("world one")
      yield* llm.text("world one")
      yield* llm.text("world one")
      yield* llm.text("world one")
      yield* llm.text("world one")
      yield* llm.text("world one")

      const first = yield* Effect.promise(() => SessionPrompt.loop({ sessionID: session.id }))
      expect(first.info.role).toBe("assistant")
      expect(first.parts.some((part) => part.type === "text" && part.text === "world one")).toBe(true)

      yield* Effect.promise(() =>
        SessionPrompt.prompt({
          sessionID: session.id,
          agent: "build",
          noReply: true,
          parts: [{ type: "text", text: "hello two" }],
        }),
      )

      yield* llm.text("world two")
      yield* llm.text("world two")
      yield* llm.text("world two")
      yield* llm.text("world two")
      yield* llm.text("world two")
      yield* llm.text("world two")

      const second = yield* Effect.promise(() => SessionPrompt.loop({ sessionID: session.id }))
      expect(second.info.role).toBe("assistant")
      expect(second.parts.some((part) => part.type === "text" && part.text === "world two")).toBe(true)

      expect(yield* llm.hits).toHaveLength(12)
      expect(yield* llm.pending).toBe(0)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop continues when finish is tool-calls", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const session = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* prompt.prompt({
        sessionID: session.id,
        agent: "build",
        noReply: true,
        parts: [{ type: "text", text: "hello" }],
      })
      yield* llm.tool("first", { value: "first" })
      yield* llm.text("second")
      yield* llm.text("second")
      yield* llm.text("second")
      yield* llm.text("second")
      yield* llm.text("second")
      yield* llm.text("second")

      const result = yield* prompt.loop({ sessionID: session.id })
      expect(yield* llm.calls).toBe(7)
      expect(result.info.role).toBe("assistant")
      if (result.info.role === "assistant") {
        expect(result.parts.some((part) => part.type === "text" && part.text === "second")).toBe(true)
        expect(result.info.finish).toBe("stop")
      }
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("failed subtask preserves metadata on error tool state", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({ title: "Pinned" })
      yield* llm.tool("task", {
        description: "inspect bug",
        prompt: "look into the cache key path",
        subagent_type: "general",
      })
      yield* llm.text("done")
      yield* llm.text("done")
      yield* llm.text("done")
      yield* llm.text("done")
      yield* llm.text("done")
      yield* llm.text("done")
      const msg = yield* user(chat.id, "hello")
      yield* addSubtask(chat.id, msg.id)

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(result.info.role).toBe("assistant")
      expect(yield* llm.calls).toBe(7)

      const msgs = yield* Effect.sync(() => MessageV2.filterCompacted(MessageV2.stream(chat.id)))
      const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
      expect(taskMsg?.info.role).toBe("assistant")
      if (!taskMsg || taskMsg.info.role !== "assistant") return

      const tool = errorTool(taskMsg.parts)
      if (!tool) return

      expect(tool.state.error).toContain("Tool execution failed")
      expect(tool.state.metadata).toBeDefined()
      expect(tool.state.metadata?.sessionId).toBeDefined()
      expect(tool.state.metadata?.model).toEqual({
        providerID: ProviderID.make("test"),
        modelID: ModelID.make("missing-model"),
      })
    }),
    {
      git: true,
      config: (url) => ({
        ...providerCfg(url),
        agent: {
          general: {
            model: "test/missing-model",
          },
        },
      }),
    },
  ),
)

it.live("eval command resolves instruction once and inherits session context", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        let text = ""
        const init = spyOn(TaskTool, "init").mockImplementation(async () => ({
          description: "task",
          parameters: z.object({
            description: z.string(),
            prompt: z.string(),
            subagent_type: z.string(),
            task_id: z.string().optional(),
            command: z.string().optional(),
          }),
          execute: async (args) => {
            text = args.prompt
            const child = await Session.create({})
            const msg = await Session.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              sessionID: child.id,
              parentID: MessageID.ascending(),
              mode: "eval",
              agent: "eval",
              path: { cwd: "/tmp", root: "/tmp" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ref.modelID,
              providerID: ref.providerID,
              time: { created: Date.now(), completed: Date.now() },
              finish: "tool-calls",
            })
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: child.id,
              type: "tool",
              callID: "eval_pass",
              tool: "eval_result",
              state: {
                status: "completed",
                input: { pass: true, summary: "ok" },
                title: "",
                output: JSON.stringify({ pass: true, summary: "ok" }),
                metadata: { pass: true, summary: "ok" },
                time: { start: Date.now(), end: Date.now() },
              },
            })
            return {
              title: "",
              metadata: {
                sessionId: child.id,
                model: ref,
                eval: { pass: true, summary: "ok", sessionId: child.id, round: 1, phase: "passed" },
              },
              output: "",
            }
          },
        }))
        yield* Effect.addFinalizer(() => Effect.sync(() => init.mockRestore()))

        const { prompt, chat, sessions } = yield* boot()
        const msg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "voice-build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: chat.id,
          type: "text",
          text: "ship it",
        })

        yield* Effect.promise(() =>
          SessionPrompt.command({
            sessionID: chat.id,
            command: Command.Default.EVAL,
            arguments: "double check output",
          }),
        )

        expect(text).toContain("## User Instruction")
        expect(text).toContain("ship it")
        expect(text).toContain("double check output")
        expect(text.match(/## Additional Context/g)?.length ?? 0).toBe(1)

        const all = yield* Effect.promise(() => Session.messages({ sessionID: chat.id }))
        const item = all.find(
          (entry) => entry.info.role === "user" && entry.parts.some((part) => part.type === "subtask"),
        )
        expect(item?.info.role).toBe("user")
        if (!item || item.info.role !== "user") return
        expect(item.info.agent).toBe("voice-build")
        expect(item.info.model).toEqual(ref)
        expect(
          all.some(
            (entry) =>
              entry.info.role === "user" &&
              entry.parts.some((part) => part.type === "text" && part.text === "Eval passed." && part.eval === true),
          ),
        ).toBe(true)
      }),
    { git: true, config: cfg },
  ),
)

it.live("eval command fails closed and ignores older successful task sessions", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const init = spyOn(TaskTool, "init").mockImplementation(async () => ({
        description: "task",
        parameters: z.object({
          description: z.string(),
          prompt: z.string(),
          subagent_type: z.string(),
          task_id: z.string().optional(),
          command: z.string().optional(),
        }),
        execute: async () => {
          const child = await Session.create({})
          const msg = await Session.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: child.id,
            parentID: MessageID.ascending(),
            mode: "eval",
            agent: "eval",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          })
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: child.id,
            type: "text",
            text: "done",
          })
          return {
            title: "",
            metadata: { sessionId: child.id, model: ref },
            output: "",
          }
        },
      }))
      yield* Effect.addFinalizer(() => Effect.sync(() => init.mockRestore()))

      const { chat, sessions } = yield* boot()
      const root = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: root.id,
        sessionID: chat.id,
        type: "text",
        text: "ship it",
      })

      const old = yield* Effect.promise(() => Session.create({}))
      const oldMsg = yield* Effect.promise(() =>
        Session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: old.id,
          parentID: MessageID.ascending(),
          mode: "eval",
          agent: "eval",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "tool-calls",
        }),
      )
      yield* Effect.promise(() =>
        Session.updatePart({
          id: PartID.ascending(),
          messageID: oldMsg.id,
          sessionID: old.id,
          type: "tool",
          callID: "old_eval",
          tool: "eval_result",
          state: {
            status: "completed",
            input: { pass: true, summary: "old" },
            title: "",
            output: JSON.stringify({ pass: true, summary: "old" }),
            metadata: { pass: true, summary: "old" },
            time: { start: Date.now(), end: Date.now() },
          },
        }),
      )

      const oldTask = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID: chat.id,
        parentID: root.id,
        mode: "general",
        agent: "general",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "tool-calls",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: oldTask.id,
        sessionID: chat.id,
        type: "tool",
        callID: "old_task",
        tool: "task",
        state: {
          status: "completed",
          input: { command: Command.Default.EVAL },
          title: "",
          output: "done",
          metadata: { sessionId: old.id, model: ref },
          time: { start: Date.now(), end: Date.now() },
        },
      })

      // First response: text-only triggers the eval action nudge.
      // Second response: a bash tool satisfies the "took action" check.
      // Third response: final text after tool-calls continuation.
      yield* llm.text("fixed")
      yield* llm.tool("bash", { command: "bun test" })
      yield* llm.text("verified")
      yield* llm.text("verified")
      yield* llm.text("verified")
      yield* llm.text("verified")
      yield* llm.text("verified")
      yield* llm.text("verified")

      const result = yield* Effect.promise(() =>
        SessionPrompt.command({
          sessionID: chat.id,
          command: Command.Default.EVAL,
          arguments: "",
        }),
      )

      expect(result.info.role).toBe("assistant")

      const all = yield* Effect.promise(() => Session.messages({ sessionID: chat.id }))
      expect(
        all.some(
          (entry) =>
            entry.info.role === "user" &&
            entry.parts.some((part) => part.type === "text" && part.text.includes("did not return a valid result")),
        ),
      ).toBe(true)
      expect(
        all.some(
          (entry) =>
            entry.info.role === "user" && entry.parts.some((part) => part.type === "text" && part.eval === true),
        ),
      ).toBe(false)
      // Eval action nudge should have fired since the first response was text-only
      expect(
        all.some(
          (entry) =>
            entry.info.role === "user" &&
            entry.parts.some(
              (part) =>
                part.type === "text" && part.synthetic === true && part.text.includes("did not make any changes"),
            ),
        ),
      ).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

// Eval finish nudge tests — exercise the nudge added to runLoop that
// reminds the eval agent to call eval_result when it finishes with text.

it.live(
  "eval agent is nudged to call eval_result when it finishes with text only",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const parent = yield* sessions.create({ title: "Build" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Eval" })

        const msg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: child.id,
          agent: "eval",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: child.id,
          type: "text",
          text: "Evaluate the build output",
        })

        // First call: text only — triggers the eval finish nudge
        yield* llm.text("The code looks correct")
        // Second call: after nudge, model calls eval_result
        yield* llm.tool("eval_result", { pass: true, summary: "All checks pass" })

        yield* prompt.loop({ sessionID: child.id })

        const all = yield* Effect.promise(() => Session.messages({ sessionID: child.id }))
        // Nudge should have been injected
        expect(
          all.some(
            (entry) =>
              entry.info.role === "user" &&
              entry.parts.some(
                (part) =>
                  part.type === "text" && part.synthetic === true && part.text.includes("MUST call eval_result"),
              ),
          ),
        ).toBe(true)
        // eval_result should have been called
        expect(
          all.some((entry) =>
            entry.parts.some(
              (part) => part.type === "tool" && part.tool === "eval_result" && part.state.status === "completed",
            ),
          ),
        ).toBe(true)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "eval agent exits after exhausting eval_result nudges",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const parent = yield* sessions.create({ title: "Build" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Eval" })

        const msg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: child.id,
          agent: "eval",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: child.id,
          type: "text",
          text: "Evaluate the build output",
        })

        // 3 text responses: initial + 2 nudge responses (MAX_EVAL_NUDGES = 2)
        yield* llm.text("looks fine")
        yield* llm.text("everything passes")
        yield* llm.text("all good")

        yield* prompt.loop({ sessionID: child.id })

        const all = yield* Effect.promise(() => Session.messages({ sessionID: child.id }))
        // Both nudges should have fired
        const nudges = all.filter(
          (entry) =>
            entry.info.role === "user" &&
            entry.parts.some(
              (part) => part.type === "text" && part.synthetic === true && part.text.includes("MUST call eval_result"),
            ),
        )
        expect(nudges.length).toBe(2)
        // eval_result should NOT be present
        expect(
          all.some((entry) =>
            entry.parts.some(
              (part) => part.type === "tool" && part.tool === "eval_result" && part.state.status === "completed",
            ),
          ),
        ).toBe(false)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "eval agent calling eval_result immediately is not affected by nudge",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const parent = yield* sessions.create({ title: "Build" })
        const child = yield* sessions.create({ parentID: parent.id, title: "Eval" })

        const msg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: child.id,
          agent: "eval",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msg.id,
          sessionID: child.id,
          type: "text",
          text: "Evaluate the build output",
        })

        // eval_result called immediately — no nudge needed
        yield* llm.tool("eval_result", { pass: false, summary: "Missing tests" })

        yield* prompt.loop({ sessionID: child.id })

        const all = yield* Effect.promise(() => Session.messages({ sessionID: child.id }))
        // No nudge should have fired
        expect(
          all.some(
            (entry) =>
              entry.info.role === "user" &&
              entry.parts.some(
                (part) =>
                  part.type === "text" && part.synthetic === true && part.text.includes("MUST call eval_result"),
              ),
          ),
        ).toBe(false)
        // eval_result should be present
        expect(
          all.some((entry) =>
            entry.parts.some(
              (part) => part.type === "tool" && part.tool === "eval_result" && part.state.status === "completed",
            ),
          ),
        ).toBe(true)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live(
  "loop sets status to busy then idle",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const status = yield* SessionStatus.Service

        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        expect((yield* status.get(chat.id)).type).toBe("busy")
        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
        expect((yield* status.get(chat.id)).type).toBe("idle")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Cancel semantics

it.live(
  "cancel interrupts loop and resolves with an assistant message",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* seed(chat.id)

        yield* llm.hang

        yield* user(chat.id, "more")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel records MessageAbortedError on interrupted process",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        yield* prompt.cancel(chat.id)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          const info = exit.value.info
          if (info.role === "assistant") {
            expect(info.error?.name).toBe("MessageAbortedError")
          }
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "cancel finalizes subtask tool state",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const ready = defer<void>()
          const aborted = defer<void>()
          const init = spyOn(TaskTool, "init").mockImplementation(async () => ({
            description: "task",
            parameters: z.object({
              description: z.string(),
              prompt: z.string(),
              subagent_type: z.string(),
              task_id: z.string().optional(),
              command: z.string().optional(),
            }),
            execute: async (_args, ctx) => {
              ready.resolve()
              ctx.abort.addEventListener("abort", () => aborted.resolve(), { once: true })
              await new Promise<void>(() => {})
              return {
                title: "",
                metadata: {
                  sessionId: SessionID.make("task"),
                  model: ref,
                },
                output: "",
              }
            },
          }))
          yield* Effect.addFinalizer(() => Effect.sync(() => init.mockRestore()))

          const { prompt, chat } = yield* boot()
          const msg = yield* user(chat.id, "hello")
          yield* addSubtask(chat.id, msg.id)

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.promise(() => ready.promise)
          yield* prompt.cancel(chat.id)
          yield* Effect.promise(() => aborted.promise)

          const exit = yield* Fiber.await(fiber)
          expect(Exit.isSuccess(exit)).toBe(true)

          const msgs = yield* Effect.sync(() => MessageV2.filterCompacted(MessageV2.stream(chat.id)))
          const taskMsg = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "general")
          expect(taskMsg?.info.role).toBe("assistant")
          if (!taskMsg || taskMsg.info.role !== "assistant") return

          const tool = toolPart(taskMsg.parts)
          expect(tool?.type).toBe("tool")
          if (!tool) return

          expect(tool.state.status).not.toBe("running")
          expect(taskMsg.info.time.completed).toBeDefined()
          expect(taskMsg.info.finish).toBeDefined()
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

it.live(
  "cancel with queued callers resolves all cleanly",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hello")

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        yield* prompt.cancel(chat.id)
        const [exitA, exitB] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(exitA)).toBe(true)
        expect(Exit.isSuccess(exitB)).toBe(true)
        if (Exit.isSuccess(exitA) && Exit.isSuccess(exitB)) {
          expect(exitA.value.info.id).toBe(exitB.value.info.id)
        }
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

// Queue semantics

it.live("concurrent loop callers get same result", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        yield* seed(chat.id, { finish: "stop" })

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })

        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
        yield* prompt.assertNotBusy(chat.id)
      }),
    { git: true },
  ),
)

it.live(
  "concurrent loop callers all receive same error result",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* Effect.forEach(
          Array.from({ length: 18 }, () => 0),
          () => llm.fail("boom"),
        )
        yield* user(chat.id, "hello")

        const [a, b] = yield* Effect.all([prompt.loop({ sessionID: chat.id }), prompt.loop({ sessionID: chat.id })], {
          concurrency: "unbounded",
        })
        expect(a.info.id).toBe(b.info.id)
        expect(a.info.role).toBe("assistant")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "prompt submitted during an active run is included in the next LLM input",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const gate = defer<void>()
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })

        yield* llm.hold("first", gate.promise)
        yield* llm.text("n1")
        yield* llm.text("n2")
        yield* llm.text("n3")
        yield* llm.text("n4")
        yield* llm.text("n5")
        yield* llm.text("second")

        const a = yield* prompt
          .prompt({
            sessionID: chat.id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "first" }],
          })
          .pipe(Effect.forkChild)

        yield* llm.wait(1)

        const id = MessageID.ascending()
        const b = yield* prompt
          .prompt({
            sessionID: chat.id,
            messageID: id,
            agent: "build",
            model: ref,
            parts: [{ type: "text", text: "second" }],
          })
          .pipe(Effect.forkChild)

        yield* Effect.promise(async () => {
          const end = Date.now() + 5000
          while (Date.now() < end) {
            const msgs = await Effect.runPromise(sessions.messages({ sessionID: chat.id }))
            if (msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)) return
            await new Promise((done) => setTimeout(done, 20))
          }
          throw new Error("timed out waiting for second prompt to save")
        })

        gate.resolve()

        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])
        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        expect(yield* llm.calls).toBe(7)

        const msgs = yield* sessions.messages({ sessionID: chat.id })
        const assistants = msgs.filter((msg) => msg.info.role === "assistant")
        expect(assistants.length).toBeGreaterThanOrEqual(2)
        expect(msgs.some((msg) => msg.info.role === "user" && msg.info.id === id)).toBe(true)
        const reply = assistants.findLast((msg) =>
          msg.parts.some((part) => part.type === "text" && part.text === "second"),
        )
        expect(reply?.info.role).toBe("assistant")

        const inputs = yield* llm.inputs
        expect(inputs).toHaveLength(7)
        expect(JSON.stringify(inputs.at(-1)?.messages)).toContain("second")
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "assertNotBusy throws BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        yield* llm.hang

        const chat = yield* sessions.create({})
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live("assertNotBusy succeeds when idle", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service

        const chat = yield* sessions.create({})
        const exit = yield* prompt.assertNotBusy(chat.id).pipe(Effect.exit)
        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    { git: true },
  ),
)

// Shell semantics

it.live(
  "shell rejects with BusyError when loop running",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({ title: "Pinned" })
        yield* llm.hang
        yield* user(chat.id, "hi")

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1)

        const exit = yield* prompt.shell({ sessionID: chat.id, agent: "build", command: "echo hi" }).pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
        }

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix("shell captures stdout and stderr in completed tool output", () =>
  provideTmpdirInstance(
    (dir) =>
      Effect.gen(function* () {
        const { prompt, chat } = yield* boot()
        const result = yield* prompt.shell({
          sessionID: chat.id,
          agent: "build",
          command: "printf out && printf err >&2",
        })

        expect(result.info.role).toBe("assistant")
        const tool = completedTool(result.parts)
        if (!tool) return

        expect(tool.state.output).toContain("out")
        expect(tool.state.output).toContain("err")
        expect(tool.state.metadata.output).toContain("out")
        expect(tool.state.metadata.output).toContain("err")
        yield* prompt.assertNotBusy(chat.id)
      }),
    { git: true, config: cfg },
  ),
)

// Skip: depends on tmux delivering intermediate output within tight timing
// constraints that are not reliably met across all environments.
it.live.skip(
  "shell updates running metadata before process exit",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const fiber = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "printf first && sleep 0.2 && printf second" })
              .pipe(Effect.forkChild)

            yield* Effect.promise(async () => {
              const start = Date.now()
              while (Date.now() - start < 5000) {
                const msgs = MessageV2.filterCompacted(MessageV2.stream(chat.id))
                const taskMsg = msgs.find((item) => item.info.role === "assistant")
                const tool = taskMsg ? toolPart(taskMsg.parts) : undefined
                if (tool?.state.status === "running" && tool.state.metadata?.output.includes("first")) return
                await new Promise((done) => setTimeout(done, 20))
              }
              throw new Error("timed out waiting for running shell metadata")
            })

            const exit = yield* Fiber.await(fiber)
            expect(Exit.isSuccess(exit)).toBe(true)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

it.live(
  "loop waits while shell runs and starts after shell exits",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("after-shell")
        yield* llm.text("after-shell")
        yield* llm.text("after-shell")
        yield* llm.text("after-shell")
        yield* llm.text("after-shell")
        yield* llm.text("after-shell")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const exit = yield* Fiber.await(loop)

        expect(Exit.isSuccess(exit)).toBe(true)
        if (Exit.isSuccess(exit)) {
          expect(exit.value.info.role).toBe("assistant")
          expect(exit.value.parts.some((part) => part.type === "text" && part.text === "after-shell")).toBe(true)
        }
        expect(yield* llm.calls).toBe(6)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

it.live(
  "shell completion resumes queued loop callers",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done")
        yield* llm.text("done")
        yield* llm.text("done")
        yield* llm.text("done")
        yield* llm.text("done")
        yield* llm.text("done")

        const sh = yield* prompt
          .shell({ sessionID: chat.id, agent: "build", command: "sleep 0.2" })
          .pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        const a = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        const b = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* Effect.sleep(50)

        expect(yield* llm.calls).toBe(0)

        yield* Fiber.await(sh)
        const [ea, eb] = yield* Effect.all([Fiber.await(a), Fiber.await(b)])

        expect(Exit.isSuccess(ea)).toBe(true)
        expect(Exit.isSuccess(eb)).toBe(true)
        if (Exit.isSuccess(ea) && Exit.isSuccess(eb)) {
          expect(ea.value.info.id).toBe(eb.value.info.id)
          expect(ea.value.info.role).toBe("assistant")
        }
        expect(yield* llm.calls).toBe(6)
      }),
      { git: true, config: providerCfg },
    ),
  3_000,
)

unix(
  "cancel interrupts shell and resolves cleanly",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const status = yield* SessionStatus.Service
            expect((yield* status.get(chat.id)).type).toBe("idle")
            const busy = yield* prompt.assertNotBusy(chat.id).pipe(Effect.exit)
            expect(Exit.isSuccess(busy)).toBe(true)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel persists aborted shell result when shell ignores TERM",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const sh = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "trap '' TERM; sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            yield* prompt.cancel(chat.id)

            const exit = yield* Fiber.await(sh)
            expect(Exit.isSuccess(exit)).toBe(true)
            if (Exit.isSuccess(exit)) {
              expect(exit.value.info.role).toBe("assistant")
              const tool = completedTool(exit.value.parts)
              if (tool) {
                expect(tool.state.output).toContain("User aborted the command")
              }
            }
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

unix(
  "cancel interrupts loop queued behind shell",
  () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const { prompt, chat } = yield* boot()

          const sh = yield* prompt
            .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
            .pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          const loop = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
          yield* Effect.sleep(50)

          yield* prompt.cancel(chat.id)

          const exit = yield* Fiber.await(loop)
          expect(Exit.isSuccess(exit)).toBe(true)

          yield* Fiber.await(sh)
        }),
      { git: true, config: cfg },
    ),
  30_000,
)

unix(
  "shell rejects when another shell is already running",
  () =>
    withSh(() =>
      provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            const { prompt, chat } = yield* boot()

            const a = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "sleep 30" })
              .pipe(Effect.forkChild)
            yield* Effect.sleep(50)

            const exit = yield* prompt
              .shell({ sessionID: chat.id, agent: "build", command: "echo hi" })
              .pipe(Effect.exit)
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) {
              expect(Cause.squash(exit.cause)).toBeInstanceOf(Session.BusyError)
            }

            yield* prompt.cancel(chat.id)
            yield* Fiber.await(a)
          }),
        { git: true, config: cfg },
      ),
    ),
  30_000,
)

// Todo nudge tests

it.live("loop nudges build agent when todos are incomplete", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      const root = yield* user(chat.id, "implement the feature")
      const turn = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "assistant",
        sessionID: chat.id,
        parentID: root.id,
        mode: "build",
        agent: "build",
        path: { cwd: "/tmp", root: "/tmp" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: ref.modelID,
        providerID: ref.providerID,
        time: { created: Date.now(), completed: Date.now() },
        finish: "stop",
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: turn.id,
        sessionID: chat.id,
        type: "text",
        text: "I started on the first task.",
      })

      Todo.update({
        sessionID: chat.id,
        todos: [
          { content: "Create the schema", status: "completed", priority: "high" },
          { content: "Add the API route", status: "pending", priority: "high" },
          { content: "Write tests", status: "pending", priority: "medium" },
        ],
      })

      // Todos stay pending, so the nudge fires up to MAX_TODO_NUDGES (3) times
      yield* llm.text("continuing work 1")
      yield* llm.text("continuing work 2")
      yield* llm.text("continuing work 3")
      yield* llm.text("k1")
      yield* llm.text("k2")
      yield* llm.text("k3")
      yield* llm.text("k4")
      yield* llm.text("k5")

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(8)
      expect(result.info.role).toBe("assistant")

      const msgs = yield* Effect.sync(() => MessageV2.filterCompacted(MessageV2.stream(chat.id)))
      const nudge = msgs.find(
        (msg) =>
          msg.info.role === "user" &&
          msg.parts.some(
            (part) =>
              part.type === "text" &&
              part.synthetic === true &&
              part.text.includes("todo list still has incomplete items"),
          ),
      )
      expect(nudge?.info.role).toBe("user")
      // Verify the nudge message includes the todo status list
      const text = nudge?.parts.find((p) => p.type === "text")
      expect(text?.type === "text" && text.text.includes("[pending] Add the API route")).toBe(true)
    }),
    { git: true, config: providerCfg },
  ),
)

it.live("loop does not nudge when all todos are completed", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const prompt = yield* SessionPrompt.Service
      const sessions = yield* Session.Service
      const chat = yield* sessions.create({
        title: "Pinned",
        permission: [{ permission: "*", pattern: "*", action: "allow" }],
      })
      yield* seed(chat.id, { finish: "stop" })

      Todo.update({
        sessionID: chat.id,
        todos: [
          { content: "Create the schema", status: "completed", priority: "high" },
          { content: "Skipped task", status: "cancelled", priority: "low" },
        ],
      })

      const result = yield* prompt.loop({ sessionID: chat.id })
      expect(yield* llm.calls).toBe(0)
      expect(result.info.role).toBe("assistant")
    }),
    { git: true, config: providerCfg },
  ),
)

it.live(
  "loop limits todo nudges to 3",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "Pinned",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const root = yield* user(chat.id, "implement feature")
        const turn = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: chat.id,
          parentID: root.id,
          mode: "build",
          agent: "build",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: turn.id,
          sessionID: chat.id,
          type: "text",
          text: "started",
        })

        Todo.update({
          sessionID: chat.id,
          todos: [{ content: "Task A", status: "pending", priority: "high" }],
        })

        // Queue 3 text responses (one per todo nudge), then 5 for KIRA nudges after todo cap
        yield* llm.text("still working 1")
        yield* llm.text("still working 2")
        yield* llm.text("still working 3")
        yield* llm.text("k1")
        yield* llm.text("k2")
        yield* llm.text("k3")
        yield* llm.text("k4")
        yield* llm.text("k5")

        yield* prompt.loop({ sessionID: chat.id })
        expect(yield* llm.calls).toBe(8)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

it.live("loop nudges build agent when eval feedback gets no action", () =>
  provideTmpdirServer(
    Effect.fnUntraced(function* ({ llm }) {
      const init = spyOn(TaskTool, "init").mockImplementation(async () => ({
        description: "task",
        parameters: z.object({
          description: z.string(),
          prompt: z.string(),
          subagent_type: z.string(),
          task_id: z.string().optional(),
          command: z.string().optional(),
        }),
        execute: async () => {
          const child = await Session.create({})
          const msg = await Session.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: child.id,
            parentID: MessageID.ascending(),
            mode: "eval",
            agent: "eval",
            path: { cwd: "/tmp", root: "/tmp" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "tool-calls",
          })
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: msg.id,
            sessionID: child.id,
            type: "tool",
            callID: "eval_fail",
            tool: "eval_result",
            state: {
              status: "completed",
              input: { pass: false, summary: "tests fail" },
              title: "",
              output: JSON.stringify({
                pass: false,
                summary: "tests fail",
                issues: [{ description: "missing assertion", severity: "error" }],
              }),
              metadata: {
                pass: false,
                summary: "tests fail",
                issues: [{ description: "missing assertion", severity: "error" }],
              },
              time: { start: Date.now(), end: Date.now() },
            },
          })
          return {
            title: "",
            metadata: {
              sessionId: child.id,
              model: ref,
              eval: { pass: false, summary: "tests fail", sessionId: child.id, round: 1, phase: "failed" },
            },
            output: "",
          }
        },
      }))
      yield* Effect.addFinalizer(() => Effect.sync(() => init.mockRestore()))

      // First response: text-only (triggers eval action nudge)
      // Second response: bash tool (satisfies action check)
      // Third response: final text after tool-calls continuation
      yield* llm.text("I will address these changes")
      yield* llm.tool("bash", { command: "bun test" })
      yield* llm.text("tests pass now")
      yield* llm.text("tests pass now")
      yield* llm.text("tests pass now")
      yield* llm.text("tests pass now")
      yield* llm.text("tests pass now")
      yield* llm.text("tests pass now")

      const { chat, sessions } = yield* boot()
      const root = yield* sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user",
        sessionID: chat.id,
        agent: "build",
        model: ref,
        time: { created: Date.now() },
      })
      yield* sessions.updatePart({
        id: PartID.ascending(),
        messageID: root.id,
        sessionID: chat.id,
        type: "text",
        text: "ship it",
      })

      yield* Effect.promise(() =>
        SessionPrompt.command({
          sessionID: chat.id,
          command: Command.Default.EVAL,
          arguments: "",
        }),
      )

      const all = yield* Effect.promise(() => Session.messages({ sessionID: chat.id }))
      // Verify the eval action nudge was injected
      expect(
        all.some(
          (entry) =>
            entry.info.role === "user" &&
            entry.parts.some(
              (part) =>
                part.type === "text" && part.synthetic === true && part.text.includes("did not make any changes"),
            ),
        ),
      ).toBe(true)
      // Verify the loop continued past the nudge (more than 1 assistant response)
      const assistants = all.filter((entry) => entry.info.role === "assistant")
      expect(assistants.length).toBeGreaterThanOrEqual(2)
    }),
    { git: true, config: providerCfg },
  ),
)

// ── Plan nudge tests ──────────────────────────────────────────────

it.live(
  "plan nudge fires when plan agent finishes without plan_exit in manual mode",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const prompt = yield* SessionPrompt.Service
        const sessions = yield* Session.Service
        const chat = yield* sessions.create({
          title: "PlanNudge",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        const root = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "plan",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: root.id,
          sessionID: chat.id,
          type: "text",
          text: "create a feature",
        })
        // Plan agent responds without calling plan_exit
        const turn = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: chat.id,
          parentID: root.id,
          mode: "build",
          agent: "plan",
          path: { cwd: "/tmp", root: "/tmp" },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "stop",
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: turn.id,
          sessionID: chat.id,
          type: "text",
          text: "Here is my plan: do X, Y, Z.",
        })

        // Nudge fires, LLM is called. Hang the LLM so we can inspect state.
        yield* llm.hang

        const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.forkChild)
        yield* llm.wait(1) // Wait for LLM to be called (after nudge)

        const msgs = yield* Effect.sync(() => MessageV2.filterCompacted(MessageV2.stream(chat.id)))
        const nudge = msgs.find(
          (msg) =>
            msg.info.role === "user" &&
            msg.parts.some(
              (part) =>
                part.type === "text" &&
                part.synthetic === true &&
                part.text.includes("Your turn ended without completing the plan"),
            ),
        )
        expect(nudge).toBeDefined()
        // Manual mode nudge should mention plan_exit
        const nudgeText = nudge?.parts.find((p) => p.type === "text")
        expect(nudgeText?.type === "text" && nudgeText.text.includes("call plan_exit")).toBe(true)

        yield* prompt.cancel(chat.id)
        yield* Fiber.await(fiber)
      }),
      { git: true, config: providerCfg },
    ),
  10_000,
)

// ── Interactive eval fail → fix → reeval ──────────────────────────

it.live(
  "eval failure injects feedback with correct round and issues metadata",
  () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ llm }) {
        const issues = [{ description: "no test coverage", severity: "error", file: "src/app.ts" }]
        const init = spyOn(TaskTool, "init").mockImplementation(async () => ({
          description: "task",
          parameters: z.object({
            description: z.string(),
            prompt: z.string(),
            subagent_type: z.string(),
            task_id: z.string().optional(),
            command: z.string().optional(),
          }),
          execute: async () => {
            const child = await Session.create({})
            const msg = await Session.updateMessage({
              id: MessageID.ascending(),
              role: "assistant",
              sessionID: child.id,
              parentID: MessageID.ascending(),
              mode: "eval",
              agent: "eval",
              path: { cwd: "/tmp", root: "/tmp" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              modelID: ref.modelID,
              providerID: ref.providerID,
              time: { created: Date.now(), completed: Date.now() },
              finish: "tool-calls",
            })
            await Session.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID: child.id,
              type: "tool",
              callID: "eval_1",
              tool: "eval_result",
              state: {
                status: "completed",
                input: { pass: false, summary: "missing test" },
                title: "",
                output: JSON.stringify({ pass: false, summary: "missing test", issues }),
                metadata: { pass: false, summary: "missing test", issues },
                time: { start: Date.now(), end: Date.now() },
              },
            })
            return {
              title: "",
              metadata: {
                sessionId: child.id,
                model: ref,
                eval: { pass: false, summary: "missing test", issues, sessionId: child.id, round: 1, phase: "failed" },
              },
              output: "",
            }
          },
        }))
        yield* Effect.addFinalizer(() => Effect.sync(() => init.mockRestore()))

        // Agent responds with bash action (satisfies the action check so loop breaks)
        yield* llm.tool("bash", { command: "echo test > test.ts" })
        yield* llm.text("fixed it")
        yield* llm.text("fixed it")
        yield* llm.text("fixed it")
        yield* llm.text("fixed it")
        yield* llm.text("fixed it")
        yield* llm.text("fixed it")

        const { chat, sessions } = yield* boot()
        const root = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: chat.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: root.id,
          sessionID: chat.id,
          type: "text",
          text: "build it",
        })

        yield* Effect.promise(() =>
          SessionPrompt.command({
            sessionID: chat.id,
            command: Command.Default.EVAL,
            arguments: "",
          }),
        )

        const all = yield* Effect.promise(() => Session.messages({ sessionID: chat.id }))

        // Verify feedback message was injected with eval metadata
        const feedbackPart = all
          .flatMap((e) => e.parts)
          .find(
            (p) =>
              p.type === "text" && "metadata" in p && (p.metadata as Record<string, any>)?.eval?.phase === "failed",
          )
        expect(feedbackPart).toBeDefined()

        // Verify round 1 and issues in metadata
        if (feedbackPart && "metadata" in feedbackPart) {
          const evalMeta = (feedbackPart.metadata as Record<string, any>)?.eval
          expect(evalMeta?.round).toBe(1)
          expect(evalMeta?.pass).toBe(false)
          expect(evalMeta?.issues).toBeDefined()
        }

        // Verify feedback text contains structured error section
        if (feedbackPart?.type === "text") {
          expect(feedbackPart.text).toContain("Errors (must fix)")
          expect(feedbackPart.text).toContain("no test coverage")
        }
      }),
      { git: true, config: providerCfg },
    ),
  15_000,
)
