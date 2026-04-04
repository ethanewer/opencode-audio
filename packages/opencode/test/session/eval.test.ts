import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Eval } from "../../src/session/eval"
import { Session } from "../../src/session"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Instance } from "../../src/project/instance"
import * as SessionPrompt from "../../src/session/prompt"
import * as SessionSummary from "../../src/session/summary"
import { tmpdir } from "../fixture/fixture"

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(async () => {
  mock.restore()
  await Instance.disposeAll()
})

async function user(sessionID: SessionID, text: string, agent = "voice-build") {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent,
    model: ref,
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: msg.id,
    sessionID,
    type: "text",
    text,
  })
  return msg
}

async function verdict(sessionID: SessionID, pass: boolean, summary: string) {
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
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
    sessionID,
    type: "tool",
    callID: "call_eval",
    tool: "eval_result",
    state: {
      status: "completed",
      input: { pass, summary },
      title: "",
      output: JSON.stringify({ pass, summary }),
      metadata: { pass, summary },
      time: { start: Date.now(), end: Date.now() },
    },
  })
}

async function tool(sessionID: SessionID) {
  const userMsg = await user(sessionID, "build output")
  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID: userMsg.id,
    mode: "build",
    agent: "build",
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
    sessionID,
    type: "tool",
    callID: "call_patch",
    tool: "apply_patch",
    state: {
      status: "completed",
      input: { patchText: "*** Begin Patch" },
      title: "",
      output: "ok",
      metadata: {
        diff: "--- a.txt\n+++ a.txt\n+hello",
        files: [{ filePath: "/tmp/a.txt", movePath: undefined }],
      },
      time: { start: Date.now(), end: Date.now() },
    },
  })
}

async function build(
  sessionID: SessionID,
  input: {
    agent?: string
    model?: { providerID: ProviderID; modelID: ModelID }
    parts: Array<{ type: string; text?: string; metadata?: Record<string, unknown> }>
  },
  rebuttal?: string,
) {
  const userMsg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID,
    agent: input.agent ?? "build",
    model: input.model ?? ref,
    time: { created: Date.now() },
  })
  const text = input.parts.find((part) => part.type === "text")
  await Session.updatePart({
    id: PartID.ascending(),
    messageID: userMsg.id,
    sessionID,
    type: "text",
    text: text?.text ?? "",
    metadata: text?.metadata,
  })

  const msg = await Session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant",
    sessionID,
    parentID: userMsg.id,
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now(), completed: Date.now() },
    finish: rebuttal ? "tool-calls" : "stop",
  })

  if (rebuttal) {
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "tool",
      callID: "call_rebuttal",
      tool: Eval.REBUT,
      state: {
        status: "completed",
        input: { content: rebuttal },
        title: "Evaluation Rebuttal",
        output: rebuttal,
        metadata: { content: rebuttal },
        time: { start: Date.now(), end: Date.now() },
      },
    })
  } else {
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID,
      type: "text",
      text: "fixing",
    })
  }

  return (await Session.messages({ sessionID })).at(-1)!
}

describe("session.eval", () => {
  test("retries with the original session agent and fresh diffs", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const chat = await Session.create({})
        await user(chat.id, "ship it")

        const prompts: string[] = []
        const builds: Array<{ agent?: string; model?: { providerID: string; modelID: string } }> = []
        let diff = 0
        let evals = 0

        spyOn(SessionSummary.SessionSummary, "computeDiff")
          .mockImplementationOnce(async () => [
            { file: "a.ts", before: "old", after: "new", additions: 1, deletions: 1, status: "modified" },
          ])
          .mockImplementationOnce(async () => [
            { file: "b.ts", before: "one", after: "two", additions: 1, deletions: 1, status: "modified" },
          ])

        spyOn(SessionPrompt.SessionPrompt, "prompt").mockImplementation(async (input) => {
          if (input.sessionID === chat.id) {
            builds.push({ agent: input.agent, model: input.model as never })
            return (await Session.messages({ sessionID: chat.id }))[0]!
          }
          prompts.push(String(input.parts.find((part) => part.type === "text")?.text ?? ""))
          evals++
          await verdict(input.sessionID, evals > 1, evals > 1 ? "ok" : "bad")
          diff++
          return (await Session.messages({ sessionID: input.sessionID })).at(-1)!
        })

        const result = await Eval.run({
          sessionID: chat.id,
          instruction: "ship it",
          max: 2,
        })

        expect(result.pass).toBe(true)
        expect(builds).toHaveLength(1)
        expect(builds[0]?.agent).toBe("voice-build")
        expect(builds[0]?.model).toEqual(ref)
        expect(prompts[0]).toContain("a.ts")
        expect(prompts[1]).toContain("b.ts")
        expect(prompts[0]).not.toContain("b.ts")
      },
    })
  })

  test("falls back to tool metadata when snapshot diffs are unavailable", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const chat = await Session.create({})
        await tool(chat.id)

        const prompts: string[] = []

        spyOn(SessionSummary.SessionSummary, "computeDiff").mockResolvedValue([])
        spyOn(SessionPrompt.SessionPrompt, "prompt").mockImplementation(async (input) => {
          prompts.push(String(input.parts.find((part) => part.type === "text")?.text ?? ""))
          await verdict(input.sessionID, true, "ok")
          return (await Session.messages({ sessionID: input.sessionID })).at(-1)!
        })

        const result = await Eval.run({
          sessionID: chat.id,
          instruction: "check it",
          max: 1,
        })

        expect(result.pass).toBe(true)
        expect(prompts[0]).toContain("/tmp/a.txt")
        expect(prompts[0]).toContain("--- a.txt")
      },
    })
  })

  test("fails when the eval agent does not call eval_result", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const chat = await Session.create({})
        await user(chat.id, "ship it")

        spyOn(SessionSummary.SessionSummary, "computeDiff").mockResolvedValue([])
        spyOn(SessionPrompt.SessionPrompt, "prompt").mockImplementation(async (input) => {
          const msg = await Session.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID: input.sessionID,
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
            sessionID: input.sessionID,
            type: "text",
            text: "done",
          })
          return (await Session.messages({ sessionID: input.sessionID })).at(-1)!
        })

        const result = await Eval.run({
          sessionID: chat.id,
          instruction: "ship it",
          max: 1,
        })

        expect(result.pass).toBe(false)
        expect(result.summary).toBe("Eval agent did not call eval_result")
      },
    })
  })

  test("reuses the same eval session when build submits a rebuttal", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const chat = await Session.create({})
        await user(chat.id, "ship it")

        spyOn(SessionSummary.SessionSummary, "computeDiff").mockResolvedValue([])

        let child: SessionID | undefined
        let evals = 0

        spyOn(SessionPrompt.SessionPrompt, "prompt").mockImplementation(async (input) => {
          if (input.sessionID === chat.id) {
            return build(chat.id, input as never, "the requirement is already satisfied")
          }

          evals++
          if (!child) child = input.sessionID
          expect(input.sessionID).toBe(child)
          await verdict(input.sessionID, evals > 1, evals > 1 ? "ok" : "bad")
          return (await Session.messages({ sessionID: input.sessionID })).at(-1)!
        })

        const result = await Eval.run({
          sessionID: chat.id,
          instruction: "ship it",
          max: 2,
        })

        expect(result.pass).toBe(true)
        expect(result.attempt).toBe(1)
        expect(result.round).toBe(2)
        expect(result.rebutted).toBe(true)
        expect(evals).toBe(2)
      },
    })
  })
})
