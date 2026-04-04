import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Command } from "../../src/command"
import { Instance } from "../../src/project/instance"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { TaskTool } from "../../src/tool/task"
import { tmpdir } from "../fixture/fixture"

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("tool.task", () => {
  test("description sorts subagents by name and is stable across calls", async () => {
    await using tmp = await tmpdir({
      config: {
        agent: {
          zebra: {
            description: "Zebra agent",
            mode: "subagent",
          },
          alpha: {
            description: "Alpha agent",
            mode: "subagent",
          },
        },
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const build = await Agent.get("build")
        const first = await TaskTool.init({ agent: build })
        const second = await TaskTool.init({ agent: build })

        expect(first.description).toBe(second.description)

        const alpha = first.description.indexOf("- alpha: Alpha agent")
        const explore = first.description.indexOf("- explore:")
        const general = first.description.indexOf("- general:")
        const zebra = first.description.indexOf("- zebra: Zebra agent")

        expect(alpha).toBeGreaterThan(-1)
        expect(explore).toBeGreaterThan(alpha)
        expect(general).toBeGreaterThan(explore)
        expect(zebra).toBeGreaterThan(general)
      },
    })
  })

  test("returns eval metadata when eval_result is present", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: session.id,
          parentID: MessageID.ascending(),
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "tool-calls",
        })
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(async (input) => ({
          info: {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: input.sessionID,
            parentID: MessageID.ascending(),
            mode: "eval",
            agent: "eval",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "tool-calls",
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: MessageID.ascending(),
              sessionID: input.sessionID,
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
            },
          ],
        }))

        try {
          const task = await TaskTool.init()
          const result = await task.execute(
            {
              description: "review",
              prompt: "check this",
              subagent_type: "eval",
              command: Command.Default.EVAL,
            },
            {
              sessionID: session.id,
              messageID: msg.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { bypassAgentCheck: true },
              messages: [],
              metadata() {},
              ask: async () => {},
            },
          )

          expect(result.metadata.sessionId).toBeString()
          expect(result.metadata.eval).toEqual({ pass: true, summary: "ok" })
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })

  test("omits eval metadata when eval_result is missing", async () => {
    await using tmp = await tmpdir()

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const msg = await Session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: session.id,
          parentID: MessageID.ascending(),
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ref.modelID,
          providerID: ref.providerID,
          time: { created: Date.now(), completed: Date.now() },
          finish: "tool-calls",
        })
        const prompt = spyOn(SessionPrompt, "prompt").mockImplementation(async (input) => ({
          info: {
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: input.sessionID,
            parentID: MessageID.ascending(),
            mode: "eval",
            agent: "eval",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ref.modelID,
            providerID: ref.providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: MessageID.ascending(),
              sessionID: input.sessionID,
              type: "text",
              text: "done",
            },
          ],
        }))

        try {
          const task = await TaskTool.init()
          const result = await task.execute(
            {
              description: "review",
              prompt: "check this",
              subagent_type: "eval",
              command: Command.Default.EVAL,
            },
            {
              sessionID: session.id,
              messageID: msg.id,
              agent: "build",
              abort: new AbortController().signal,
              extra: { bypassAgentCheck: true },
              messages: [],
              metadata() {},
              ask: async () => {},
            },
          )

          expect(result.metadata.sessionId).toBeString()
          expect(result.metadata.eval).toBeUndefined()
        } finally {
          prompt.mockRestore()
        }
      },
    })
  })
})
