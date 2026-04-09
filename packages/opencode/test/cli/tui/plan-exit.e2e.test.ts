import { describe, expect, test } from "bun:test"
import http from "node:http"
import path from "path"
import { spawn } from "bun-pty"
import { tmpdir } from "../../fixture/fixture"

const root = path.join(import.meta.dirname, "../../../src/index.ts")
const mods = path.join(import.meta.dirname, "../../../../../node_modules")
const cwd = path.join(import.meta.dirname, "../../..")

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

function plan(body: Record<string, unknown>, dir: string) {
  const match = JSON.stringify(body).match(/create your plan at ([^\\n]+?) using the write tool/)
  if (!match) return
  const filePath = match[1].startsWith(dir) ? path.relative(dir, match[1]) : match[1]
  return { filePath, content: "Approved plan" }
}

async function llm(dir: string) {
  const hits = [] as Record<string, unknown>[]
  let seq = 0
  let step = 0
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

    const raw = JSON.stringify(hits.at(-1) ?? {})

    res.writeHead(200, { "content-type": "text/event-stream" })
    if (raw.includes("Generate a title for this conversation")) {
      res.end(text("Pinned"))
      return
    }

    const file = plan(hits.at(-1) ?? {}, dir)
    if (step === 0 && file) {
      step += 1
      seq += 1
      res.end(tool("write", file, seq))
      return
    }

    if (step === 1) {
      step += 1
      seq += 1
      res.end(tool("plan_exit", {}, seq))
      return
    }

    if (step >= 2) {
      res.end(text("implemented"))
      return
    }
    res.end(text("waiting"))
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
    OPENCODE_CLI_PLAN_AUTO_BUILD: "1",
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

async function wait(check: () => boolean, ms: number, info: () => string) {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (check()) return
    await Bun.sleep(100)
  }
  throw new Error(`timed out after ${ms}ms\n${info()}`)
}

async function start(extra: Record<string, string>, args: string[]) {
  return spawn(process.execPath, ["run", "--conditions=browser", root, ...args], {
    cwd,
    env: extra,
    name: "xterm-256color",
  })
}

describe("cli.tui.plan_exit.e2e", () => {
  test("interactive tui plan mode exposes plan_exit", async () => {
    await using tmp = await tmpdir({ git: true })
    const server = await llm(tmp.path)
    const proc = await start(env(tmp.path, server.url), [
      tmp.path,
      "--model",
      "test/test-model",
      "--agent",
      "plan",
      "--prompt",
      "Plan the work",
    ])
    let out = ""
    proc.onData((chunk) => {
      out += chunk
    })

    try {
      await wait(
        () => {
          const hits = JSON.stringify(server.hits())
          return hits.includes('"name":"plan_exit"')
        },
        30000,
        () => `hits=${JSON.stringify(server.hits(), null, 2)}\nout=${out}`,
      )

      const hits = JSON.stringify(server.hits())
      expect(hits).toContain('"name":"plan_exit"')
    } finally {
      try {
        proc.kill()
      } catch {}
      await server.close()
    }
  }, 40000)
})
