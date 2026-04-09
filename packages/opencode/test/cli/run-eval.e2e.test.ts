import { describe, expect, test } from "bun:test"
import http from "node:http"
import path from "path"
import { spawn } from "bun-pty"
import stripAnsi from "strip-ansi"
import { tmpdir } from "../fixture/fixture"

const root = path.join(import.meta.dirname, "../../src/index.ts")
const mods = path.join(import.meta.dirname, "../../../../node_modules")
const cwd = path.join(import.meta.dirname, "../..")

function cfg(url: string) {
  return JSON.stringify({
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
      eval: { model: "test/test-model" },
    },
  })
}

function sse(lines: unknown[]) {
  return [...lines.map((line) => `data: ${JSON.stringify(line)}`), "data: [DONE]"].join("\n\n") + "\n\n"
}

function text(value: string) {
  return sse([
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" } }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: { content: value } }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: {}, finish_reason: "stop" }],
    },
  ])
}

function tool(name: string, input: unknown, seq: number) {
  const id = `call_${seq}`
  const args = JSON.stringify(input)
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
                  name,
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

async function llm() {
  let seq = 0
  const steps: Array<(s: number) => string> = [
    // Build: finish with task_complete double-confirmation
    () => { seq++; return tool("task_complete", {}, seq) },
    () => { seq++; return tool("task_complete", {}, seq) },
    // Eval attempt 1: fail
    () => { seq++; return tool("eval_result", { pass: false, summary: "missing guard" }, seq) },
    // Build rebuttal: eval_rebuttal then task_complete twice
    () => { seq++; return tool("eval_rebuttal", { content: "the guard already exists" }, seq) },
    () => { seq++; return tool("task_complete", {}, seq) },
    () => { seq++; return tool("task_complete", {}, seq) },
    // Eval re-review: pass
    () => { seq++; return tool("eval_result", { pass: true, summary: "ok" }, seq) },
  ]
  let idx = 0
  const server = http.createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404)
      res.end()
      return
    }

    for await (const _ of req) {
    }

    const fn = steps[idx++]
    if (!fn) {
      res.writeHead(500)
      res.end("unexpected request")
      return
    }
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.end(fn(idx))
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
  const addr = server.address()
  if (!addr || typeof addr === "string") throw new Error("failed to start llm test server")

  return {
    url: `http://127.0.0.1:${addr.port}/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}

function env(dir: string, url: string) {
  const xdg = path.join(dir, ".xdg")
  return {
    ...process.env,
    NO_COLOR: "1",
    OPENCODE_PURE: "1",
    OPENCODE_CONFIG_CONTENT: cfg(url),
    OPENCODE_DB: ":memory:",
    NODE_PATH: mods,
    XDG_DATA_HOME: path.join(xdg, "data"),
    XDG_CONFIG_HOME: path.join(xdg, "config"),
    XDG_CACHE_HOME: path.join(xdg, "cache"),
    XDG_STATE_HOME: path.join(xdg, "state"),
    TERM: "xterm-256color",
  }
}

async function wait(proc: ReturnType<typeof spawn>, ms = 30000) {
  let out = ""
  proc.onData((chunk) => {
    out += chunk
  })

  const exit = new Promise<number>((resolve) => {
    proc.onExit(({ exitCode }) => resolve(exitCode))
  })

  const timer = new Promise<number>((_, reject) => {
    setTimeout(() => {
      try {
        proc.kill()
      } catch {}
      reject(new Error(`timed out after ${ms}ms\n${stripAnsi(out)}`))
    }, ms)
  })

  const code = await Promise.race([exit, timer])
  return { code, out: stripAnsi(out) }
}

async function start(extra: Record<string, string>, args: string[]) {
  return spawn(process.execPath, ["run", "--conditions=browser", root, ...args], {
    cwd,
    env: extra,
    name: "xterm-256color",
  })
}

describe("cli.run.eval.e2e", () => {
  test("headless run supports eval rebuttal loop", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = await llm()

    try {
      const res = await wait(
        await start(env(tmp.path, server.url), [
          "run",
          "--model",
          "test/test-model",
          "--agent",
          "build",
          "--eval",
          "--eval-iterations",
          "2",
          "--title",
          "Pinned",
          "ship it",
        ]),
      )

      expect(res.code).toBe(0)
      expect(res.out).toContain("Running eval...")
      expect(res.out).toContain("Eval attempt 1/2")
      expect(res.out).toContain("Build rebuttal submitted")
      expect(res.out).toContain("Evaluator reconsidering rebuttal")
      expect(res.out).toContain("Eval passed: ok")
    } finally {
      await server.close()
    }
  }, 40000)
})
