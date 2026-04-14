import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "fs/promises"
import http from "node:http"
import path from "path"
import * as QuestionModule from "../../src/question"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { PlanExitTool } from "../../src/tool/plan"
import { tmpdir } from "../fixture/fixture"

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
      plan: { model: "test/test-model" },
      build: { model: "test/test-model" },
    },
  }
}

type Step = { type: "text"; text: string } | { type: "tool"; tool: string; input: unknown }

function sse(lines: unknown[]) {
  return [...lines.map((line) => `data: ${JSON.stringify(line)}`), "data: [DONE]"].join("\n\n") + "\n\n"
}

function textStep(step: Extract<Step, { type: "text" }>) {
  return sse([
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" } }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: { content: step.text } }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "stop" }],
    },
  ])
}

function toolStep(step: Extract<Step, { type: "tool" }>, seq: number) {
  const id = `call_${seq}`
  const args = JSON.stringify(step.input)
  return sse([
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" } }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: {
                  name: step.tool,
                  arguments: "",
                },
              },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                function: {
                  arguments: args,
                },
              },
            ],
          },
        },
      ],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    },
  ])
}

async function llm(steps: Step[]) {
  const hits = [] as Record<string, unknown>[]
  let seq = 0
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404)
      res.end()
      return
    }

    const chunks = [] as Buffer[]
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString("utf8")
    hits.push(body ? JSON.parse(body) : {})

    const step = steps.shift()
    if (!step) {
      res.writeHead(500)
      res.end("unexpected request")
      return
    }

    res.writeHead(200, { "content-type": "text/event-stream" })
    if (step.type === "text") {
      res.end(textStep(step))
      return
    }
    seq += 1
    res.end(toolStep(step, seq))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("failed to start llm test server")

  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    hits: () => [...hits],
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

function ctx(sessionID: SessionID, agent: string): Tool.Context {
  return {
    sessionID,
    messageID: MessageID.make("msg_tool"),
    callID: "call_tool",
    agent,
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => {},
    ask: async () => {},
  }
}

async function seed(sessionID: SessionID, agent: string) {
  const msg: MessageV2.Info = {
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    time: { created: Date.now() },
    agent,
    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-5.2") },
  }
  await Session.updateMessage(msg)
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text: "draft a plan",
  })
}

async function plan(sessionID: SessionID) {
  const msgs = await Session.messages({ sessionID })
  return msgs.find(
    (item) => item.info.role === "user" && item.parts.some((part) => part.type === "text" && part.synthetic),
  )
}

function text(msg?: MessageV2.WithParts) {
  return msg?.parts.find((part) => part.type === "text")?.text ?? ""
}

async function latest(sessionID: SessionID) {
  const msgs = await Session.messages({ sessionID })
  return msgs.at(-1)
}

afterEach(async () => {
  delete process.env.OPENCODE_CLI_PLAN_AUTO_BUILD
  mock.restore()
  await Instance.disposeAll()
})

describe("tool.plan_exit", () => {
  test("rejects outside plan mode", async () => {
    const tool = await PlanExitTool.init()
    await expect(tool.execute({}, ctx(SessionID.make("ses_fake"), "build"))).rejects.toThrow(
      "The plan_exit tool can only be used while in plan mode.",
    )
  })

  test("is available for the plan agent in cli mode", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const agent = await Agent.get("plan")
        const tools = await ToolRegistry.tools(
          {
            providerID: ProviderID.make("openai"),
            modelID: ModelID.make("gpt-5.4"),
          },
          agent,
        )

        expect(tools.some((item) => item.id === "plan_exit")).toBe(true)
      },
    })
  })

  test("asks before switching to build in interactive mode", async () => {
    const ask = spyOn(QuestionModule.Question, "ask").mockResolvedValue({ answers: [["Yes"]] })

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const file = Session.plan(session)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, "Ship the feature")
        await seed(session.id, "plan")

        const tool = await PlanExitTool.init()
        const result = await tool.execute({}, ctx(session.id, "plan"))

        expect(ask).toHaveBeenCalledTimes(1)
        expect(result.title).toBe("Switching to build agent")
        expect(result.metadata?.handoff).toBe(true)
        expect(result.metadata?.sessionID).toBeDefined()

        // Verify a new session was created with the plan as the first message
        const sid = SessionID.make(result.metadata!.sessionID as string)
        const msgs = await Session.messages({ sessionID: sid })
        const first = msgs[0]
        expect(first?.info.role).toBe("user")
        expect(first?.info.agent).toBe("build")
        expect(text(first)).toBe("Ship the feature")
      },
    })
  })

  test("auto-approves and switches plan sessions to build", async () => {
    const ask = spyOn(QuestionModule.Question, "ask").mockResolvedValue({ answers: [["Yes"]] })
    process.env.OPENCODE_CLI_PLAN_AUTO_BUILD = "1"

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const file = Session.plan(session)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, "Implement the approved plan")
        await seed(session.id, "plan")

        const tool = await PlanExitTool.init()
        const result = await tool.execute({}, ctx(session.id, "plan"))

        expect(ask).not.toHaveBeenCalled()
        expect(result.output).toContain("Plan approved automatically")
        expect(result.metadata?.handoff).toBe(true)
        expect(result.metadata?.sessionID).toBeDefined()

        const sid = SessionID.make(result.metadata!.sessionID as string)
        const msgs = await Session.messages({ sessionID: sid })
        const first = msgs[0]
        expect(first?.info.agent).toBe("build")
        expect(text(first)).toBe("Implement the approved plan")
      },
    })
  })

  test("auto-approves via session permissions without env var (TUI auto mode)", async () => {
    const ask = spyOn(QuestionModule.Question, "ask").mockResolvedValue({ answers: [["Yes"]] })

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({
          permission: [
            { permission: "question", action: "deny", pattern: "*" },
            { permission: "speak", action: "deny", pattern: "*" },
            { permission: "plan_enter", action: "deny", pattern: "*" },
            { permission: "tui_auto", action: "deny", pattern: "*" },
          ],
        })
        const file = Session.plan(session)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, "TUI auto plan body")
        await seed(session.id, "plan")

        const tool = await PlanExitTool.init()
        const result = await tool.execute({}, ctx(session.id, "plan"))

        expect(ask).not.toHaveBeenCalled()
        expect(result.output).toContain("Plan approved automatically")
        expect(result.metadata?.handoff).toBe(true)
        expect(result.metadata?.sessionID).toBeDefined()

        const sid = SessionID.make(result.metadata!.sessionID as string)
        const msgs = await Session.messages({ sessionID: sid })
        const first = msgs[0]
        expect(first?.info.agent).toBe("build")
        expect(text(first)).toBe("TUI auto plan body")
      },
    })
  })

  test("auto-approves and switches voice-plan sessions to voice-build", async () => {
    const ask = spyOn(QuestionModule.Question, "ask").mockResolvedValue({ answers: [["Yes"]] })
    process.env.OPENCODE_CLI_PLAN_AUTO_BUILD = "1"

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const file = Session.plan(session)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, "Speak the implementation steps")
        await seed(session.id, "voice-plan")

        const tool = await PlanExitTool.init()
        const result = await tool.execute({}, ctx(session.id, "voice-plan"))

        expect(ask).not.toHaveBeenCalled()
        expect(result.title).toBe("Switching to voice-build agent")
        expect(result.metadata?.handoff).toBe(true)

        const sid = SessionID.make(result.metadata!.sessionID as string)
        const msgs = await Session.messages({ sessionID: sid })
        const first = msgs[0]
        expect(first?.info.agent).toBe("voice-build")
        expect(text(first)).toBe("Speak the implementation steps")
      },
    })
  })

  test("always creates a build session regardless of prior agent", async () => {
    process.env.OPENCODE_CLI_PLAN_AUTO_BUILD = "1"

    await using tmp = await tmpdir({
      git: true,
      config: {
        agent: {
          qa: { mode: "primary", model: "openai/gpt-5.2" },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const file = Session.plan(session)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, "Validate the rollout")
        await seed(session.id, "qa")
        await seed(session.id, "plan")

        const tool = await PlanExitTool.init()
        const result = await tool.execute({}, ctx(session.id, "plan"))

        expect(result.title).toBe("Switching to build agent")
        expect(result.metadata?.handoff).toBe(true)

        const sid = SessionID.make(result.metadata!.sessionID as string)
        const msgs = await Session.messages({ sessionID: sid })
        const first = msgs[0]
        expect(first?.info.agent).toBe("build")
        expect(text(first)).toBe("Validate the rollout")
      },
    })
  })

  test("rejects plan exit when the plan file is missing", async () => {
    process.env.OPENCODE_CLI_PLAN_AUTO_BUILD = "1"

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await seed(session.id, "plan")

        const tool = await PlanExitTool.init()
        await expect(tool.execute({}, ctx(session.id, "plan"))).rejects.toThrow("No finalized plan found")
      },
    })
  })

  test("stays in plan mode when the user keeps planning", async () => {
    spyOn(QuestionModule.Question, "ask").mockResolvedValue({ answers: [["Run tests first"]] })

    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const file = Session.plan(session)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await Bun.write(file, "Draft the rollout")
        await seed(session.id, "plan")

        const tool = await PlanExitTool.init()
        const result = await tool.execute({}, ctx(session.id, "plan"))
        const msg = await latest(session.id)

        expect(result.title).toBe("Continuing in plan mode")
        expect(result.output).toContain("Run tests first")
        expect(result.metadata?.followup).toBe(true)
        expect(msg?.info.role).toBe("user")
        expect(msg?.info.agent).toBe("plan")
        expect(text(msg)).toContain("Run tests first")
      },
    })
  })

  test("loop auto-handoffs a fresh plan run into build", async () => {
    process.env.OPENCODE_CLI_PLAN_AUTO_BUILD = "1"

    const server = await llm([
      { type: "tool", tool: "plan_exit", input: {} },
      { type: "tool", tool: "task_complete", input: {} },
      { type: "tool", tool: "task_complete", input: {} },
    ])

    try {
      await using tmp = await tmpdir({ git: true, config: providerCfg(server.url) })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({
            title: "Pinned",
            permission: [
              { permission: "question", action: "deny", pattern: "*" },
              { permission: "plan_enter", action: "deny", pattern: "*" },
            ],
          })
          const file = Session.plan(session)
          await fs.mkdir(path.dirname(file), { recursive: true })
          await Bun.write(file, "Follow the approved plan")
          await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "plan",
            noReply: true,
            parts: [{ type: "text", text: "Plan the work" }],
          })

          const result = await SessionPrompt.loop({ sessionID: session.id })
          const msgs = await Session.messages({ sessionID: session.id })
          const turn = msgs.find((item) => item.info.role === "assistant" && item.info.agent === "plan")

          // The result is from the build session (new session)
          expect(server.hits()).toHaveLength(3)
          expect(result.info.role).toBe("assistant")
          expect(result.info.sessionID).not.toBe(session.id)
          expect(turn && turn.info.role === "assistant" ? turn.info.finish : undefined).toBe("tool-calls")

          // The build session should have the plan content as first message
          const sid = result.info.sessionID
          const build = await Session.messages({ sessionID: sid })
          const first = build[0]
          expect(first?.info.agent).toBe("build")
          expect(text(first)).toBe("Follow the approved plan")

          // The build LLM request should contain the plan content
          const next = JSON.stringify(server.hits()[1])
          expect(next).toContain("Follow the approved plan")
        },
      })
    } finally {
      await server.close()
    }
  }, 30000)

  test("loop auto-handoffs via session permissions without env var (TUI auto mode)", async () => {
    const server = await llm([
      { type: "tool", tool: "plan_exit", input: {} },
      { type: "tool", tool: "task_complete", input: {} },
      { type: "tool", tool: "task_complete", input: {} },
    ])

    try {
      await using tmp = await tmpdir({ git: true, config: providerCfg(server.url) })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({
            title: "TUI Auto",
            permission: [
              { permission: "question", action: "deny", pattern: "*" },
              { permission: "speak", action: "deny", pattern: "*" },
              { permission: "plan_enter", action: "deny", pattern: "*" },
              { permission: "tui_auto", action: "deny", pattern: "*" },
            ],
          })
          const file = Session.plan(session)
          await fs.mkdir(path.dirname(file), { recursive: true })
          await Bun.write(file, "TUI auto plan content")
          await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "plan",
            noReply: true,
            parts: [{ type: "text", text: "Plan the work" }],
          })

          const result = await SessionPrompt.loop({ sessionID: session.id })

          // The result is from the build session (new session)
          expect(server.hits()).toHaveLength(3)
          expect(result.info.role).toBe("assistant")
          expect(result.info.sessionID).not.toBe(session.id)

          // The build session should have the plan content as first message
          const sid = result.info.sessionID
          const build = await Session.messages({ sessionID: sid })
          const first = build[0]
          expect(first?.info.agent).toBe("build")
          expect(text(first)).toBe("TUI auto plan content")

          // The build LLM request should contain the plan content
          const next = JSON.stringify(server.hits()[1])
          expect(next).toContain("TUI auto plan content")
        },
      })
    } finally {
      await server.close()
    }
  }, 30000)

  test("loop retries plan mode when the model stops without plan_exit", async () => {
    process.env.OPENCODE_CLI_PLAN_AUTO_BUILD = "1"

    const server = await llm([
      { type: "text", text: "Plan:\n1. Run bun typecheck.\n2. Run bun test." },
      { type: "tool", tool: "plan_exit", input: {} },
      { type: "tool", tool: "task_complete", input: {} },
      { type: "tool", tool: "task_complete", input: {} },
    ])

    try {
      await using tmp = await tmpdir({ git: true, config: providerCfg(server.url) })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await Session.create({
            title: "Pinned",
            permission: [
              { permission: "question", action: "deny", pattern: "*" },
              { permission: "plan_enter", action: "deny", pattern: "*" },
            ],
          })
          const file = Session.plan(session)
          await fs.mkdir(path.dirname(file), { recursive: true })
          await Bun.write(file, "Follow the approved plan")
          await SessionPrompt.prompt({
            sessionID: session.id,
            agent: "plan",
            noReply: true,
            parts: [{ type: "text", text: "Run type checking and tests in the repo." }],
          })

          const result = await SessionPrompt.loop({ sessionID: session.id })
          const retry = JSON.stringify(server.hits()[1])

          // The result is from the build session (new session)
          expect(server.hits()).toHaveLength(4)
          expect(result.info.role).toBe("assistant")
          expect(result.info.sessionID).not.toBe(session.id)
          expect(retry).toContain("Your turn ended without completing the plan")
          expect(retry).toContain("call plan_exit")

          // The build session should have the plan content
          const sid = result.info.sessionID
          const build = await Session.messages({ sessionID: sid })
          const first = build[0]
          expect(first?.info.agent).toBe("build")
          expect(text(first)).toBe("Follow the approved plan")
        },
      })
    } finally {
      await server.close()
    }
  }, 30000)
})
