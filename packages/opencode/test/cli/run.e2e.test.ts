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
      plan: { model: "test/test-model" },
      build: { model: "test/test-model" },
    },
  })
}

function sse(lines: unknown[]) {
  return [...lines.map((line) => `data: ${JSON.stringify(line)}`), "data: [DONE]"].join("\n\n") + "\n\n"
}

function text(text: string) {
  return sse([
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: { role: "assistant" } }],
    },
    {
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ delta: { content: text } }],
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

async function llm(dir: string) {
  const hits = [] as Record<string, unknown>[]
  let seq = 0
  let wrote = false
  let exited = false
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

    res.writeHead(200, { "content-type": "text/event-stream" })
    const raw = JSON.stringify(hits.at(-1) ?? {})
    const file = plan(hits.at(-1) ?? {}, dir)

    if (!wrote && file && raw.includes('"name":"write"')) {
      wrote = true
      seq += 1
      res.end(tool("write", file, seq))
      return
    }

    if (!exited && raw.includes('"name":"plan_exit"')) {
      exited = true
      seq += 1
      res.end(tool("plan_exit", {}, seq))
      return
    }

    if (exited) {
      res.end(text("implemented"))
      return
    }

    res.end(text("ok"))
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

function env(dir: string, url: string) {
  const xdg = path.join(dir, ".xdg")
  return {
    ...process.env,
    NO_COLOR: "1",
    OPENCODE_EXPERIMENTAL_PLAN_MODE: "1",
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

function plan(body: Record<string, unknown>, dir: string) {
  const match = JSON.stringify(body).match(/((?:\/[^"\\n]+|\.opencode\/[^"\\n]+|plans\/[^"\\n]+)+\.md)/)
  if (!match) return
  const filePath = match[1].startsWith(dir) ? path.relative(dir, match[1]) : match[1]
  return { filePath, content: "Approved plan" }
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

async function serve(extra: Record<string, string>) {
  const proc = await start(extra, ["serve"])
  let out = ""
  const url = await new Promise<string>((resolve, reject) => {
    const id = setTimeout(() => reject(new Error(`server did not start\n${stripAnsi(out)}`)), 30000)
    proc.onData((chunk) => {
      out += chunk
      const match = stripAnsi(out).match(/opencode server listening on (http:\/\/\S+)/)
      if (!match) return
      clearTimeout(id)
      resolve(match[1])
    })
    proc.onExit(({ exitCode }) => {
      clearTimeout(id)
      reject(new Error(`server exited early with ${exitCode}\n${stripAnsi(out)}`))
    })
  })
  return { proc, url }
}

describe("cli.run.e2e", () => {
  test("attached interactive plan runs auto-approve build handoff", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = await llm(tmp.path)

    let app: { proc: ReturnType<typeof spawn>; url: string } | undefined

    try {
      const extra = env(tmp.path, server.url)
      app = await serve(extra)
      const res = await wait(
        await start(extra, [
          "run",
          "--attach",
          app.url,
          "--dir",
          tmp.path,
          "--title",
          "Pinned",
          "--agent",
          "plan",
          "Plan the work",
        ]),
        30000,
      )

      if (res.code !== 0) throw new Error(res.out)
      expect(res.code).toBe(0)
      expect(res.out).toContain("implemented")
      expect(server.hits().length).toBeGreaterThanOrEqual(2)
      expect(JSON.stringify(server.hits())).toContain("plan_exit")
    } finally {
      if (app) {
        try {
          app.proc.kill()
        } catch {}
      }
      await server.close()
    }
  }, 45000)
})
