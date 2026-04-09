#!/usr/bin/env bun

import os from "os"
import path from "path"
import { mkdir, mkdtemp, writeFile } from "fs/promises"

const root = path.resolve(import.meta.dir, "..")
const cli = path.join(root, "src/index.ts")
const list = process.argv.includes("--list") || process.argv.includes("--no-open")
const pick = (process.argv.slice(2).find((item) => !item.startsWith("--")) ?? "failed") as "failed"
const dir = process.env.OPENCODE_EVAL_TUI_DIR ?? (await mkdtemp(path.join(os.tmpdir(), "opencode-eval-tui-")))
const db = process.env.OPENCODE_DB ?? path.join(dir, ".opencode", "eval-tui.sqlite")

process.env.OPENCODE_PURE = "1"
process.env.OPENCODE_DB = db
process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
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
        baseURL: "http://127.0.0.1:1/v1",
      },
    },
  },
  agent: {
    build: { model: "test/test-model" },
    eval: { model: "test/test-model" },
  },
})

await mkdir(path.dirname(db), { recursive: true })
await mkdir(dir, { recursive: true })
await writeFile(path.join(dir, "demo.txt"), "eval tui demo\n")
await Bun.$`git init`.cwd(dir).quiet().nothrow()
await Bun.$`git config core.fsmonitor false`.cwd(dir).quiet().nothrow()

const seed = async () => {
  const { Log } = await import("../src/util/log")
  const { Instance } = await import("../src/project/instance")
  const { InstanceBootstrap } = await import("../src/project/bootstrap")
  const { Config } = await import("../src/config/config")
  const { ToolRegistry } = await import("../src/tool/registry")
  const { Session } = await import("../src/session")
  const { Eval } = await import("../src/session/eval")
  const { MessageID, PartID } = await import("../src/session/schema")
  const { Project } = await import("../src/project/project")
  const { ProviderID, ModelID } = await import("../src/provider/schema")

  const ref = {
    providerID: ProviderID.make("test"),
    modelID: ModelID.make("test-model"),
  }

  await Log.init({ print: false, level: "ERROR" })

  let now = Date.now()
  const tick = () => {
    now += 1000
    return now
  }

  return await Instance.provide({
    directory: dir,
    init: InstanceBootstrap,
    fn: async () => {
      await Config.waitForDependencies()
      await ToolRegistry.ids()
      await Project.update({ projectID: Instance.project.id, name: "Eval TUI Demo" })

      const msg = async (input: {
        sessionID: string
        role: "user" | "assistant"
        agent: string
        parentID?: string
        mode?: string
        finish?: string
      }) => {
        return (await Session.updateMessage({
          id: MessageID.ascending(),
          role: input.role,
          sessionID: input.sessionID as never,
          ...(input.parentID ? { parentID: input.parentID as never } : {}),
          ...(input.role === "assistant"
            ? {
                mode: input.mode ?? input.agent,
                path: { cwd: dir, root: dir },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: ref.modelID,
                providerID: ref.providerID,
                time: { created: tick(), completed: tick() },
                finish: input.finish ?? "stop",
              }
            : {
                time: { created: tick() },
                model: ref,
              }),
          agent: input.agent,
        } as never)) as { id: string }
      }

      const text = async (input: {
        sessionID: string
        messageID: string
        text: string
        eval?: boolean
        ignored?: boolean
        metadata?: Record<string, unknown>
      }) => {
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: input.sessionID as never,
          messageID: input.messageID as never,
          type: "text",
          text: input.text,
          ...(input.eval ? { eval: true } : {}),
          ...(input.ignored ? { ignored: true } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        } as never)
      }

      const tool = async (input: {
        sessionID: string
        messageID: string
        tool: string
        callID: string
        state: Record<string, unknown>
      }) => {
        await Session.updatePart({
          id: PartID.ascending(),
          sessionID: input.sessionID as never,
          messageID: input.messageID as never,
          type: "tool",
          tool: input.tool,
          callID: input.callID,
          state: input.state as never,
        } as never)
      }

      const verdict = async (input: {
        sessionID: string
        parentID: string
        pass: boolean
        summary: string
        round: number
      }) => {
        const item = await msg({
          sessionID: input.sessionID,
          role: "assistant",
          parentID: input.parentID,
          agent: "eval",
          mode: "eval",
          finish: "tool-calls",
        })
        await tool({
          sessionID: input.sessionID,
          messageID: item.id,
          tool: "eval_result",
          callID: `eval_${input.round}`,
          state: {
            status: "completed",
            input: { pass: input.pass, summary: input.summary },
            title: "Evaluation",
            output: JSON.stringify({ pass: input.pass, summary: input.summary }),
            metadata: { pass: input.pass, summary: input.summary },
            time: { start: tick(), end: tick() },
          },
        })
      }

      const make = async (name: "failed") => {
        const session = (await Session.create({ title: `Eval Demo · ${name}` })) as { id: string }
        const root = await msg({ sessionID: session.id, role: "user", agent: "build" })
        await text({
          sessionID: session.id,
          messageID: root.id,
          text: "Implement the eval rebuttal flow and verify the TUI messaging.",
        })

        const child = (await Session.create({ parentID: session.id as never, title: `Eval attempt · ${name}` })) as {
          id: string
        }
        const evalReq = await msg({ sessionID: child.id, role: "user", agent: "build" })
        await text({
          sessionID: child.id,
          messageID: evalReq.id,
          text: "## Original User Instructions\n\nImplement the eval rebuttal flow and verify the TUI messaging.",
        })
        await verdict({
          sessionID: child.id,
          parentID: evalReq.id,
          pass: false,
          summary: "Missing guard around the rebuttal flow.",
          round: 1,
        })

        const review = await msg({
          sessionID: session.id,
          role: "assistant",
          parentID: root.id,
          agent: "build",
          mode: "build",
          finish: "tool-calls",
        })
        await text({
          sessionID: session.id,
          messageID: review.id,
          text: "Implemented the feature and started evaluation.",
        })
        await tool({
          sessionID: session.id,
          messageID: review.id,
          tool: "task",
          callID: `task_${name}`,
          state: {
            status: "completed",
            input: {
              description: "Review changes",
              prompt: "Review the implementation.",
              subagent_type: "eval",
              command: "eval",
            },
            title: "Eval",
            output: "",
            metadata: {
              sessionId: child.id,
              model: ref,
              eval: {
                pass: false,
                summary: "Missing guard around the rebuttal flow.",
                sessionId: child.id,
                round: 1,
                phase: "failed",
              },
            },
            time: { start: tick(), end: tick() },
          },
        })

        const fail = await msg({ sessionID: session.id, role: "user", agent: "build" })
        await text({
          sessionID: session.id,
          messageID: fail.id,
          text: Eval.feedback({
            summary: "Missing guard around the rebuttal flow.",
            issues: [
              {
                severity: "error",
                file: "src/session/eval.ts",
                description: "A failed evaluation can no longer be challenged with evidence.",
              },
            ],
          }),
          metadata: Eval.metadata({
            sessionId: child.id,
            mode: "interactive",
            policy: "stop_on_accept",
            phase: "failed",
            round: 1,
            summary: "Missing guard around the rebuttal flow.",
            pass: false,
          }),
        })

        return { session: session.id, child: child.id }
      }

      const out = {
        failed: await make("failed"),
      }

      return out
    },
  })
}

const out = await seed()
if (!(pick in out)) {
  console.error(`Unknown scenario: ${pick}`)
  console.error("Use one of: failed")
  process.exit(1)
}

console.log(`Demo workspace: ${dir}`)
console.log(`Database: ${db}`)
console.log(`Scenarios:`)
console.log(`  failed   -> ${out.failed.session}`)

if (list) process.exit(0)

const proc = Bun.spawn([process.execPath, "run", "--conditions=browser", cli, dir, "--session", out[pick].session], {
  cwd: root,
  env: {
    ...process.env,
    OPENCODE_PURE: "1",
    OPENCODE_DB: db,
    OPENCODE_CONFIG_CONTENT: process.env.OPENCODE_CONFIG_CONTENT!,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await proc.exited)
