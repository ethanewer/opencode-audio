import { NodeFileSystem } from "@effect/platform-node"
import { afterAll, afterEach, beforeEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
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
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { LLM } from "../../src/session/llm"
import { AppFileSystem } from "../../src/filesystem"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionProcessor } from "../../src/session/processor"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionStatus } from "../../src/session/status"
import { Snapshot } from "../../src/snapshot"
import { ToolRegistry } from "../../src/tool/registry"
import { Truncate } from "../../src/tool/truncate"
import { Log } from "../../src/util/log"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestLLMServer } from "../lib/llm-server"
import { Tmux } from "../../src/tmux/tmux"
import { ProviderID, ModelID } from "../../src/provider/schema"

Log.init({ print: false })

const sessions: string[] = []
afterAll(async () => {
  for (const sid of sessions) await Tmux.kill(sid)
})

let savedClient: string | undefined
beforeEach(() => {
  savedClient = process.env["OPENCODE_CLIENT"]
  process.env["OPENCODE_CLIENT"] = "app"
})
afterEach(() => {
  if (savedClient === undefined) delete process.env["OPENCODE_CLIENT"]
  else process.env["OPENCODE_CLIENT"] = savedClient
})

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
    startAuth: () => Effect.die("unexpected"),
    authenticate: () => Effect.die("unexpected"),
    finishAuth: () => Effect.die("unexpected"),
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

function providerCfg(url: string) {
  return {
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
          baseURL: url,
        },
      },
    },
    agent: {
      build: { model: "test/test-model" },
    },
  }
}

describe("kira agent integration", () => {
  it.live(
    "build agent system prompt contains KIRA template with instruction",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const session = yield* Session.Service
          const chat = yield* session.create({
            title: "KIRA Test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "Create a hello world file" }],
          })

          yield* llm.text("done")
          yield* llm.hang

          yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.ignore, Effect.forkChild)
          yield* llm.wait(1)

          const inputs = yield* llm.inputs
          const first = inputs[0]!
          const system = (first.messages as any[]).filter((m: any) => m.role === "system")
          const systemText = system.map((m: any) => m.content).join("\n")
          expect(systemText).toContain("Create a hello world file")
          expect(systemText).toContain("AI assistant tasked with solving command-line tasks")
          expect(systemText).not.toContain("Available Skills")
          expect(systemText).toContain("Current terminal state:")
        }),
        { git: true, config: providerCfg },
      ),
    10_000,
  )

  it.live(
    "build agent only gets KIRA tools in LLM request",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const session = yield* Session.Service
          const chat = yield* session.create({
            title: "KIRA Tools Test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "test task" }],
          })

          yield* llm.text("thinking")
          yield* llm.hang

          yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.ignore, Effect.forkChild)
          yield* llm.wait(1)

          const inputs = yield* llm.inputs
          const first = inputs[0]!
          const tools = (first as any).tools as { function: { name: string } }[] | undefined
          expect(tools).toBeDefined()
          const names = tools!.map((t) => t.function.name)
          expect(names).toContain("execute_commands")
          expect(names).toContain("task_complete")
          expect(names).toContain("transcribe")
          expect(names).not.toContain("bash")
          expect(names).not.toContain("read")
          expect(names).not.toContain("edit")
          expect(names).not.toContain("write")
          expect(names).not.toContain("glob")
          expect(names).not.toContain("grep")
          expect(names).not.toContain("webfetch")
          expect(names).not.toContain("task")
          expect(names).not.toContain("todowrite")
          expect(names).not.toContain("question")
          expect(names).not.toContain("eval_rebuttal")
        }),
        { git: true, config: providerCfg },
      ),
    10_000,
  )

  it.live(
    "build agent nudges when model returns text without tool calls",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const session = yield* Session.Service
          const chat = yield* session.create({
            title: "KIRA Nudge Test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "do something" }],
          })

          yield* llm.text("I'll think about it")
          yield* llm.hang

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.ignore, Effect.forkChild)
          yield* llm.wait(2)

          const inputs = yield* llm.inputs
          expect(inputs.length).toBeGreaterThanOrEqual(2)
          const raw = JSON.stringify(inputs[1])
          expect(raw).toContain("WARNINGS")
          expect(raw).toContain("no tool calls")
          expect(raw).toContain("execute_commands")
        }),
        { git: true, config: providerCfg },
      ),
    10_000,
  )

  it.live(
    "build agent exits loop after MAX_KIRA_NUDGES without tool calls",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const session = yield* Session.Service
          const chat = yield* session.create({
            title: "Max Nudge Test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "do something" }],
          })

          // 1 initial + 5 nudge responses = 6 total text responses.
          // After 5 nudges the counter is exhausted and the loop exits.
          yield* llm.text("text 1")
          yield* llm.text("text 2")
          yield* llm.text("text 3")
          yield* llm.text("text 4")
          yield* llm.text("text 5")
          yield* llm.text("text 6")

          const result = yield* prompt.loop({ sessionID: chat.id })
          expect(yield* llm.calls).toBe(6)
          expect(result.info.role).toBe("assistant")
        }),
        { git: true, config: providerCfg },
      ),
    10_000,
  )

  it.live(
    "task_complete uses extraction agent for multi-message sessions",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          const prompt = yield* SessionPrompt.Service
          const session = yield* Session.Service
          const chat = yield* session.create({
            title: "Multi-message extraction test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "Create a REST API server" }],
          })

          // Simulate a first build turn: LLM returns text, gets nudged, then returns text again, etc.
          // We need to exhaust MAX_KIRA_NUDGES (5) so the loop exits and we can add a second user message.
          yield* llm.text("thinking 1")
          yield* llm.text("thinking 2")
          yield* llm.text("thinking 3")
          yield* llm.text("thinking 4")
          yield* llm.text("thinking 5")
          yield* llm.text("thinking 6")
          yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.ignore)

          // Add second user message
          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "build",
            noReply: true,
            parts: [{ type: "text", text: "Also add authentication middleware" }],
          })

          // Build agent calls task_complete (first call → checklist).
          // Since there are 2 user messages, Eval.extract runs the extract agent.
          // Extract agent makes its own LLM call → respond with summarized instruction.
          // Build agent then calls task_complete again → confirmation. Loop exits.
          yield* llm.tool("task_complete", {})
          yield* llm.text("Create a REST API server with authentication middleware")
          yield* llm.tool("task_complete", {})

          const result = yield* prompt.loop({ sessionID: chat.id })

          const msgs = yield* Effect.promise(() => Session.messages({ sessionID: chat.id }))
          const checklist = msgs.flatMap((m) =>
            m.parts.filter(
              (p): p is MessageV2.ToolPart =>
                p.type === "tool" &&
                p.tool === "task_complete" &&
                p.state.status === "completed" &&
                p.state.output.includes("Checklist"),
            ),
          )
          expect(checklist.length).toBeGreaterThan(0)
          const part = checklist[0]!
          expect(part.state.status).toBe("completed")
          if (part.state.status === "completed") {
            expect(part.state.output).toContain("authentication middleware")
          }
        }),
        { git: true, config: providerCfg },
      ),
    30_000,
  )

  it.live(
    "plan agent gets standard tools and NOT KIRA tools or prompt",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ llm }) {
          // plan_exit requires cli mode
          process.env["OPENCODE_CLIENT"] = "cli"

          const prompt = yield* SessionPrompt.Service
          const session = yield* Session.Service
          const chat = yield* session.create({
            title: "Plan Test",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })

          yield* prompt.prompt({
            sessionID: chat.id,
            agent: "plan",
            noReply: true,
            parts: [{ type: "text", text: "plan this work" }],
          })

          // Model calls plan_exit, which makes the plan loop exit.
          // After plan_exit the loop looks for an auto-approve flow (via OPENCODE_CLI_PLAN_AUTO_BUILD).
          // Since auto-build is off, loop exits after the plan_exit tool call.
          yield* llm.tool("plan_exit", {})
          yield* llm.hang

          const fiber = yield* prompt.loop({ sessionID: chat.id }).pipe(Effect.ignore, Effect.forkChild)
          yield* llm.wait(1)

          const inputs = yield* llm.inputs
          expect(inputs.length).toBeGreaterThanOrEqual(1)
          const first = inputs[0]!
          const tools = (first as any).tools as { function: { name: string } }[] | undefined
          const names = tools?.map((t) => t.function.name) ?? []
          expect(names).toContain("bash")
          expect(names).toContain("read")
          expect(names).not.toContain("execute_commands")
          expect(names).not.toContain("task_complete")

          const system = (first.messages as any[]).filter((m: any) => m.role === "system")
          const systemText = system.map((m: any) => m.content).join("\n")
          expect(systemText).not.toContain("AI assistant tasked with solving command-line tasks")
        }),
        { git: true, config: providerCfg },
      ),
    10_000,
  )
})
