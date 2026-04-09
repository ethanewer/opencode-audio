import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import path from "path"
import * as Sdk from "@opencode-ai/sdk/v2"
import * as AgentModule from "../../src/agent/agent"
import * as Audio from "../../src/audio/transcribe"
import * as Bootstrap from "../../src/cli/bootstrap"
import { UI } from "../../src/cli/ui"
import * as EvalModule from "../../src/session/eval"
import * as SessionModule from "../../src/session"
import { tmpdir } from "../fixture/fixture"

const tty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY")

class ExitErr extends Error {
  constructor(readonly code: number | undefined) {
    super(`exit ${code ?? 0}`)
  }
}

function idle(sessionID: string) {
  return {
    type: "session.status",
    properties: {
      sessionID,
      status: { type: "idle" },
    },
  }
}

function stream(events: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event
      }
    },
  }
}

function args(input: Partial<Record<string, unknown>> = {}) {
  return {
    _: [],
    $0: "opencode",
    message: ["ship it"],
    command: undefined,
    continue: false,
    session: undefined,
    fork: false,
    share: false,
    model: undefined,
    agent: undefined,
    format: "default",
    file: undefined,
    title: undefined,
    attach: undefined,
    password: undefined,
    dir: undefined,
    port: undefined,
    variant: undefined,
    thinking: false,
    audio: undefined,
    "--": [],
    ...input,
  }
}

async function call(
  input: Partial<Record<string, unknown>> = {},
  opts?: {
    baseID?: string
    eval?: { pass: boolean; summary: string; attempt: number }
    events?: unknown[]
  },
) {
  const seen = {
    agent: undefined as string | undefined,
    auto: undefined as string | undefined,
    rules: [] as { permission: string; action: string; pattern: string }[],
    text: undefined as string | undefined,
    updated: [] as { sessionID: string; permission: { permission: string; action: string; pattern: string }[] }[],
    exit: undefined as number | undefined,
    questions: [] as { requestID: string; answers: string[][] }[],
    rejectedQuestions: [] as { requestID: string }[],
    signal: undefined as AbortSignal | undefined,
  }
  const sessionID = "ses_test"
  const activeID = (input.session as string) ?? (opts?.baseID && !input.fork ? opts.baseID : sessionID)
  const sdk = {
    config: {
      get: async () => ({ data: { share: "manual" } }),
    },
    event: {
      subscribe: async (_input?: unknown, init?: { signal?: AbortSignal }) => {
        seen.signal = init?.signal
        return { stream: stream(opts?.events ?? [idle(activeID)]) }
      },
    },
    session: {
      list: async () => ({ data: opts?.baseID ? [{ id: opts.baseID, parentID: undefined }] : [] }),
      fork: async () => ({ data: { id: sessionID } }),
      create: async (input: { permission: typeof seen.rules }) => {
        seen.rules = input.permission
        return { data: { id: sessionID } }
      },
      prompt: async (input: { agent?: string; parts: { type: string; text?: string }[] }) => {
        seen.agent = input.agent
        seen.auto = process.env.OPENCODE_CLI_PLAN_AUTO_BUILD
        seen.text = input.parts.find((part) => part.type === "text")?.text
        return { data: undefined }
      },
      command: async () => ({ data: undefined }),
    },
    permission: {
      reply: async () => ({ data: undefined }),
    },
    question: {
      reply: async (input: { requestID: string; answers: string[][] }) => {
        seen.questions.push(input)
        return { data: undefined }
      },
      reject: async (input: { requestID: string }) => {
        seen.rejectedQuestions.push(input)
        return { data: undefined }
      },
    },
  }

  spyOn(Bootstrap, "bootstrap").mockImplementation(async (_dir, fn) => fn())
  spyOn(Sdk, "createOpencodeClient").mockImplementation(() => sdk as never)
  spyOn(AgentModule.Agent, "get").mockImplementation(
    async (name) => ({ name: name ?? "plan", mode: "primary", permission: [], options: {} }) as never,
  )
  spyOn(UI, "println").mockImplementation(() => {})
  spyOn(UI, "empty").mockImplementation(() => {})
  spyOn(UI, "error").mockImplementation(() => {})
  spyOn(EvalModule.Eval, "extract").mockResolvedValue("ship it")
  spyOn(EvalModule.Eval, "run").mockResolvedValue({
    pass: opts?.eval?.pass ?? true,
    summary: opts?.eval?.summary ?? "ok",
    attempt: opts?.eval?.attempt ?? 1,
    sessionID: "ses_eval" as never,
    sessions: [],
    phase: (opts?.eval?.pass ?? true) ? "passed" : "failed",
  })
  spyOn(SessionModule.Session, "setPermission").mockImplementation(
    Object.assign(async (input: Parameters<typeof SessionModule.Session.setPermission>[0]) => {
      seen.updated.push({ sessionID: input.sessionID, permission: input.permission })
    }, SessionModule.Session.setPermission),
  )
  spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new ExitErr(code)
  }) as typeof process.exit)

  const { RunCommand } = await import("../../src/cli/cmd/run")
  try {
    await RunCommand.handler(args(input) as never)
  } catch (err) {
    if (err instanceof ExitErr) seen.exit = err.code
    else throw err
  }
  return seen
}

beforeEach(() => {
  Object.defineProperty(process.stdin, "isTTY", {
    configurable: true,
    value: true,
  })
})

afterEach(() => {
  mock.restore()
  delete process.env.OPENCODE_CLI_PLAN_AUTO_BUILD
  process.exitCode = undefined
  if (tty) Object.defineProperty(process.stdin, "isTTY", tty)
  else delete (process.stdin as { isTTY?: boolean }).isTTY
})

describe("cli.run", () => {
  test("defaults local prompt to build agent", async () => {
    const seen = await call()

    expect(seen.agent).toBeUndefined()
    expect(seen.auto).toBeUndefined()
    expect(seen.rules.some((item) => item.permission === "plan_exit" && item.action === "deny")).toBe(true)
  })

  test("transcribes audio input and uses build agent by default", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "prompt.wav")
    await Bun.write(file, new Uint8Array([82, 73, 70, 70]))
    const transcribe = spyOn(Audio, "transcribeFile").mockResolvedValue("heard it")

    const seen = await call({ message: [], audio: file })

    expect(transcribe).toHaveBeenCalledWith(file)
    expect(seen.agent).toBeUndefined()
    expect(seen.auto).toBeUndefined()
    expect(seen.text).toBe("heard it")
  })

  test("--agent plan enables plan with auto handoff", async () => {
    const seen = await call({ agent: "plan" })

    expect(seen.agent).toBe("plan")
    expect(seen.auto).toBe("1")
    expect(process.env.OPENCODE_CLI_PLAN_AUTO_BUILD).toBeUndefined()
    expect(seen.rules.some((item) => item.permission === "plan_exit")).toBe(false)
  })

  test("--agent auto routes to plan with auto handoff", async () => {
    const seen = await call({ agent: "auto" })

    expect(seen.agent).toBe("plan")
    expect(seen.auto).toBe("1")
    expect(seen.rules.some((item) => item.permission === "plan_exit")).toBe(false)
  })

  test("auto-handoffs explicit voice-plan runs without changing the voice agent", async () => {
    const seen = await call({ agent: "voice-plan" })

    expect(seen.agent).toBe("voice-plan")
    expect(seen.auto).toBe("1")
    expect(seen.rules.some((item) => item.permission === "plan_exit")).toBe(false)
  })

  test("does not redirect continued sessions into plan mode by default", async () => {
    const seen = await call({ continue: true }, { baseID: "ses_existing" })

    expect(seen.agent).toBeUndefined()
    expect(seen.auto).toBeUndefined()
  })

  test("does not redirect explicit session resumes into plan mode by default", async () => {
    const seen = await call({ session: "ses_existing" })

    expect(seen.agent).toBeUndefined()
    expect(seen.auto).toBeUndefined()
  })

  test("repairs session permissions for reused explicit plan runs", async () => {
    const seen = await call({ continue: true, agent: "plan" }, { baseID: "ses_existing" })

    expect(seen.agent).toBe("plan")
    expect(seen.auto).toBe("1")
    expect(seen.updated).toHaveLength(1)
    expect(seen.updated[0]?.permission.some((item) => item.permission === "plan_exit")).toBe(false)
  })

  test("keeps plan_exit denied for non-plan agents", async () => {
    const seen = await call({ agent: "build" })

    expect(seen.agent).toBe("build")
    expect(seen.auto).toBeUndefined()
    expect(seen.rules.some((item) => item.permission === "plan_exit" && item.action === "deny")).toBe(true)
  })

  test("sets a non-zero exit code when eval fails", async () => {
    const seen = await call({ eval: true }, { eval: { pass: false, summary: "broken", attempt: 2 } })

    expect(seen.exit).toBe(1)
  })

  test("rejects headless questions so the agent proceeds without user interaction", async () => {
    const seen = await call(
      {},
      {
        events: [
          {
            type: "question.asked",
            properties: {
              id: "req_1",
              sessionID: "ses_test",
              questions: [{ header: "Need confirmation" }],
            },
          },
          idle("ses_test"),
        ],
      },
    )

    expect(seen.rejectedQuestions).toEqual([
      {
        requestID: "req_1",
      },
    ])
    expect(seen.questions).toEqual([])
  })

  test("aborts the event subscription when the run finishes", async () => {
    const seen = await call()

    expect(seen.exit).toBe(0)
    expect(seen.signal?.aborted).toBe(true)
  })
})
