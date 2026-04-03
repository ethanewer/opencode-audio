import type { Argv } from "yargs"
import path from "path"
import { pathToFileURL } from "url"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { Flag } from "../../flag/flag"
import { bootstrap } from "../bootstrap"
import { EOL } from "os"
import { Filesystem } from "../../util/filesystem"
import { createOpencodeClient, type Message, type OpencodeClient, type ToolPart } from "@opencode-ai/sdk/v2"
import { Server } from "../../server/server"
import { Provider } from "../../provider/provider"
import { Agent } from "../../agent/agent"
import { Permission } from "../../permission"
import { Tool } from "../../tool/tool"
import { GlobTool } from "../../tool/glob"
import { GrepTool } from "../../tool/grep"
import { ListTool } from "../../tool/ls"
import { ReadTool } from "../../tool/read"
import { WebFetchTool } from "../../tool/webfetch"
import { EditTool } from "../../tool/edit"
import { WriteTool } from "../../tool/write"
import { CodeSearchTool } from "../../tool/codesearch"
import { WebSearchTool } from "../../tool/websearch"
import { TaskTool } from "../../tool/task"
import { SkillTool } from "../../tool/skill"
import { BashTool } from "../../tool/bash"
import { TodoWriteTool } from "../../tool/todo"
import { Locale } from "../../util/locale"
import { transcribeFile } from "../../audio/transcribe"
import { Session } from "../../session"
import { SessionID } from "../../session/schema"
import { Eval } from "../../session/eval"

type ToolProps<T extends Tool.Info> = {
  input: Tool.InferParameters<T>
  metadata: Tool.InferMetadata<T>
  part: ToolPart
}

function props<T extends Tool.Info>(part: ToolPart): ToolProps<T> {
  const state = part.state
  return {
    input: state.input as Tool.InferParameters<T>,
    metadata: ("metadata" in state ? state.metadata : {}) as Tool.InferMetadata<T>,
    part,
  }
}

type Inline = {
  icon: string
  title: string
  description?: string
}

function inline(info: Inline) {
  const suffix = info.description ? UI.Style.TEXT_DIM + ` ${info.description}` + UI.Style.TEXT_NORMAL : ""
  UI.println(UI.Style.TEXT_NORMAL + info.icon, UI.Style.TEXT_NORMAL + info.title + suffix)
}

function block(info: Inline, output?: string) {
  UI.empty()
  inline(info)
  if (!output?.trim()) return
  UI.println(output)
  UI.empty()
}

function fallback(part: ToolPart) {
  const state = part.state
  const input = "input" in state ? state.input : undefined
  const title =
    ("title" in state && state.title ? state.title : undefined) ||
    (input && typeof input === "object" && Object.keys(input).length > 0 ? JSON.stringify(input) : "Unknown")
  inline({
    icon: "⚙",
    title: `${part.tool} ${title}`,
  })
}

function glob(info: ToolProps<typeof GlobTool>) {
  const root = info.input.path ?? ""
  const title = `Glob "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.count
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function grep(info: ToolProps<typeof GrepTool>) {
  const root = info.input.path ?? ""
  const title = `Grep "${info.input.pattern}"`
  const suffix = root ? `in ${normalizePath(root)}` : ""
  const num = info.metadata.matches
  const description =
    num === undefined ? suffix : `${suffix}${suffix ? " · " : ""}${num} ${num === 1 ? "match" : "matches"}`
  inline({
    icon: "✱",
    title,
    ...(description && { description }),
  })
}

function list(info: ToolProps<typeof ListTool>) {
  const dir = info.input.path ? normalizePath(info.input.path) : ""
  inline({
    icon: "→",
    title: dir ? `List ${dir}` : "List",
  })
}

function read(info: ToolProps<typeof ReadTool>) {
  const file = normalizePath(info.input.filePath)
  const pairs = Object.entries(info.input).filter(([key, value]) => {
    if (key === "filePath") return false
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  const description = pairs.length ? `[${pairs.map(([key, value]) => `${key}=${value}`).join(", ")}]` : undefined
  inline({
    icon: "→",
    title: `Read ${file}`,
    ...(description && { description }),
  })
}

function write(info: ToolProps<typeof WriteTool>) {
  block(
    {
      icon: "←",
      title: `Write ${normalizePath(info.input.filePath)}`,
    },
    info.part.state.status === "completed" ? info.part.state.output : undefined,
  )
}

function webfetch(info: ToolProps<typeof WebFetchTool>) {
  inline({
    icon: "%",
    title: `WebFetch ${info.input.url}`,
  })
}

function edit(info: ToolProps<typeof EditTool>) {
  const title = normalizePath(info.input.filePath)
  const diff = info.metadata.diff
  block(
    {
      icon: "←",
      title: `Edit ${title}`,
    },
    diff,
  )
}

function codesearch(info: ToolProps<typeof CodeSearchTool>) {
  inline({
    icon: "◇",
    title: `Exa Code Search "${info.input.query}"`,
  })
}

function websearch(info: ToolProps<typeof WebSearchTool>) {
  inline({
    icon: "◈",
    title: `Exa Web Search "${info.input.query}"`,
  })
}

function task(info: ToolProps<typeof TaskTool>) {
  const input = info.part.state.input
  const status = info.part.state.status
  const subagent =
    typeof input.subagent_type === "string" && input.subagent_type.trim().length > 0 ? input.subagent_type : "unknown"
  const agent = Locale.titlecase(subagent)
  const desc =
    typeof input.description === "string" && input.description.trim().length > 0 ? input.description : undefined
  const icon = status === "error" ? "✗" : status === "running" ? "•" : "✓"
  const name = desc ?? `${agent} Task`
  inline({
    icon,
    title: name,
    description: desc ? `${agent} Agent` : undefined,
  })
}

function skill(info: ToolProps<typeof SkillTool>) {
  inline({
    icon: "→",
    title: `Skill "${info.input.name}"`,
  })
}

function bash(info: ToolProps<typeof BashTool>) {
  const output = info.part.state.status === "completed" ? info.part.state.output?.trim() : undefined
  block(
    {
      icon: "$",
      title: `${info.input.command}`,
    },
    output,
  )
}

function todo(info: ToolProps<typeof TodoWriteTool>) {
  block(
    {
      icon: "#",
      title: "Todos",
    },
    info.input.todos.map((item) => `${item.status === "completed" ? "[x]" : "[ ]"} ${item.content}`).join("\n"),
  )
}

function normalizePath(input?: string) {
  if (!input) return ""
  if (path.isAbsolute(input)) return path.relative(process.cwd(), input) || "."
  return input
}

function isPlan(agent?: string) {
  return agent === "plan" || agent === "voice-plan"
}

export const RunCommand = cmd({
  command: "run [message..]",
  describe: "run opencode with a message",
  builder: (yargs: Argv) => {
    return yargs
      .positional("message", {
        describe: "message to send",
        type: "string",
        array: true,
        default: [],
      })
      .option("command", {
        describe: "the command to run, use message for args",
        type: "string",
      })
      .option("continue", {
        alias: ["c"],
        describe: "continue the last session",
        type: "boolean",
      })
      .option("session", {
        alias: ["s"],
        describe: "session id to continue",
        type: "string",
      })
      .option("fork", {
        describe: "fork the session before continuing (requires --continue or --session)",
        type: "boolean",
      })
      .option("share", {
        type: "boolean",
        describe: "share the session",
      })
      .option("model", {
        type: "string",
        alias: ["m"],
        describe: "model to use in the format of provider/model",
      })
      .option("agent", {
        type: "string",
        describe: "agent to use",
      })
      .option("format", {
        type: "string",
        choices: ["default", "json"],
        default: "default",
        describe: "format: default (formatted) or json (raw JSON events)",
      })
      .option("file", {
        alias: ["f"],
        type: "string",
        array: true,
        describe: "file(s) to attach to message",
      })
      .option("title", {
        type: "string",
        describe: "title for the session (uses truncated prompt if no value provided)",
      })
      .option("attach", {
        type: "string",
        describe: "attach to a running opencode server (e.g., http://localhost:4096)",
      })
      .option("password", {
        alias: ["p"],
        type: "string",
        describe: "basic auth password (defaults to OPENCODE_SERVER_PASSWORD)",
      })
      .option("dir", {
        type: "string",
        describe: "directory to run in, path on remote server if attaching",
      })
      .option("port", {
        type: "number",
        describe: "port for the local server (defaults to random port if no value provided)",
      })
      .option("variant", {
        type: "string",
        describe: "model variant (provider-specific reasoning effort, e.g., high, max, minimal)",
      })
      .option("thinking", {
        type: "boolean",
        describe: "show thinking blocks",
        default: false,
      })
      .option("audio", {
        type: "string",
        describe: "path to a .wav file to transcribe as the prompt",
      })
      .option("eval", {
        type: "boolean",
        describe: "run eval agent after build completes (default: true when no --agent specified)",
      })
      .option("eval-iterations", {
        type: "number",
        default: 5,
        describe: "max number of build-eval iterations",
      })
  },
  handler: async (args) => {
    let message = [...args.message, ...(args["--"] || [])]
      .map((arg) => (arg.includes(" ") ? `"${arg.replace(/"/g, '\\"')}"` : arg))
      .join(" ")

    const directory = (() => {
      if (!args.dir) return undefined
      if (args.attach) return args.dir
      try {
        process.chdir(args.dir)
        return process.cwd()
      } catch {
        UI.error("Failed to change directory to " + args.dir)
        process.exit(1)
      }
    })()

    const files: { type: "file"; url: string; filename: string; mime: string }[] = []
    if (args.file) {
      const list = Array.isArray(args.file) ? args.file : [args.file]

      for (const filePath of list) {
        const resolvedPath = path.resolve(process.cwd(), filePath)
        if (!(await Filesystem.exists(resolvedPath))) {
          UI.error(`File not found: ${filePath}`)
          process.exit(1)
        }

        const mime = (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain"

        files.push({
          type: "file",
          url: pathToFileURL(resolvedPath).href,
          filename: path.basename(resolvedPath),
          mime,
        })
      }
    }

    if (!process.stdin.isTTY) message += "\n" + (await Bun.stdin.text())

    if (args.audio) {
      const wav = path.resolve(process.cwd(), args.audio)
      if (!(await Filesystem.exists(wav))) {
        UI.error(`Audio file not found: ${args.audio}`)
        process.exit(1)
      }
      UI.println("Transcribing audio...")
      const transcript = await transcribeFile(wav)
      UI.println(`Transcript: "${transcript}"`)
      message = transcript
    }

    if (message.trim().length === 0 && !args.command) {
      UI.error("You must provide a message or a command")
      process.exit(1)
    }

    if (args.fork && !args.continue && !args.session) {
      UI.error("--fork requires --continue or --session")
      process.exit(1)
    }

    const implicit =
      Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && !args.attach && !args.command && !args.continue && !args.session
    const agent = args.agent ?? (implicit ? "plan" : undefined)

    const rules: Permission.Ruleset = [
      {
        permission: "question",
        action: "deny",
        pattern: "*",
      },
      {
        permission: "plan_enter",
        action: "deny",
        pattern: "*",
      },
    ]
    if (!(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && isPlan(agent))) {
      rules.push({
        permission: "plan_exit",
        action: "deny",
        pattern: "*",
      })
    }

    function title() {
      if (args.title === undefined) return
      if (args.title !== "") return args.title
      return message.slice(0, 50) + (message.length > 50 ? "..." : "")
    }

    async function session(sdk: OpencodeClient) {
      const baseID = args.continue ? (await sdk.session.list()).data?.find((s) => !s.parentID)?.id : args.session

      const apply = async (sessionID: string) => {
        if (args.attach) return
        if (!(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && isPlan(agent))) return
        await Session.setPermission({
          sessionID: SessionID.make(sessionID),
          permission: rules,
        })
      }

      if (baseID && args.fork) {
        const forked = await sdk.session.fork({ sessionID: baseID })
        if (forked.data?.id) await apply(forked.data.id)
        return forked.data?.id
      }

      if (baseID) {
        await apply(baseID)
        return baseID
      }

      const name = title()
      const result = await sdk.session.create({ title: name, permission: rules })
      return result.data?.id
    }

    async function share(sdk: OpencodeClient, sessionID: string) {
      const cfg = await sdk.config.get()
      if (!cfg.data) return
      if (cfg.data.share !== "auto" && !Flag.OPENCODE_AUTO_SHARE && !args.share) return
      const res = await sdk.session.share({ sessionID }).catch((error) => {
        if (error instanceof Error && error.message.includes("disabled")) {
          UI.println(UI.Style.TEXT_DANGER_BOLD + "!  " + error.message)
        }
        return { error }
      })
      if (!res.error && "data" in res && res.data?.share?.url) {
        UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + res.data.share.url)
      }
    }

    async function execute(sdk: OpencodeClient) {
      function tool(part: ToolPart) {
        try {
          if (part.tool === "bash") return bash(props<typeof BashTool>(part))
          if (part.tool === "glob") return glob(props<typeof GlobTool>(part))
          if (part.tool === "grep") return grep(props<typeof GrepTool>(part))
          if (part.tool === "list") return list(props<typeof ListTool>(part))
          if (part.tool === "read") return read(props<typeof ReadTool>(part))
          if (part.tool === "write") return write(props<typeof WriteTool>(part))
          if (part.tool === "webfetch") return webfetch(props<typeof WebFetchTool>(part))
          if (part.tool === "edit") return edit(props<typeof EditTool>(part))
          if (part.tool === "codesearch") return codesearch(props<typeof CodeSearchTool>(part))
          if (part.tool === "websearch") return websearch(props<typeof WebSearchTool>(part))
          if (part.tool === "task") return task(props<typeof TaskTool>(part))
          if (part.tool === "todowrite") return todo(props<typeof TodoWriteTool>(part))
          if (part.tool === "skill") return skill(props<typeof SkillTool>(part))
          return fallback(part)
        } catch {
          return fallback(part)
        }
      }

      function emit(type: string, data: Record<string, unknown>) {
        if (args.format === "json") {
          process.stdout.write(JSON.stringify({ type, timestamp: Date.now(), sessionID, ...data }) + EOL)
          return true
        }
        return false
      }

      const events = await sdk.event.subscribe()
      let error: string | undefined

      // Track sessions we're actively listening for
      const active = new Set<string>()
      const waiters = new Map<string, { resolve: () => void; auto: boolean }>()

      function listen(sessionID: string, auto: boolean): Promise<void> {
        active.add(sessionID)
        return new Promise<void>((resolve) => {
          waiters.set(sessionID, { resolve, auto })
        })
      }

      function unlisten(sessionID: string) {
        active.delete(sessionID)
        const waiter = waiters.get(sessionID)
        waiters.delete(sessionID)
        waiter?.resolve()
      }

      // Background event processor — runs for the lifetime of the execute() call
      const processor = (async () => {
        const toggles = new Map<string, boolean>()

        for await (const event of events.stream) {
          if (active.size === 0) continue

          if (
            event.type === "message.updated" &&
            event.properties.info.role === "assistant" &&
            args.format !== "json"
          ) {
            const sid = event.properties.info.sessionID
            if (!active.has(sid)) continue
            const key = `start:${sid}`
            if (toggles.get(key) !== true) {
              UI.empty()
              UI.println(`> ${event.properties.info.agent} · ${event.properties.info.modelID}`)
              UI.empty()
              toggles.set(key, true)
            }
          }

          if (event.type === "message.part.updated") {
            const part = event.properties.part
            if (!active.has(part.sessionID)) continue

            if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
              if (emit("tool_use", { part })) continue
              if (part.state.status === "completed") {
                tool(part)
                continue
              }
              inline({
                icon: "✗",
                title: `${part.tool} failed`,
              })
              UI.error(part.state.error)
            }

            if (
              part.type === "tool" &&
              part.tool === "task" &&
              part.state.status === "running" &&
              args.format !== "json"
            ) {
              if (toggles.get(part.id) === true) continue
              task(props<typeof TaskTool>(part))
              toggles.set(part.id, true)
            }

            if (part.type === "step-start") {
              if (emit("step_start", { part })) continue
            }

            if (part.type === "step-finish") {
              if (emit("step_finish", { part })) continue
            }

            if (part.type === "text" && part.time?.end) {
              if (emit("text", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              if (!process.stdout.isTTY) {
                process.stdout.write(text + EOL)
                continue
              }
              UI.empty()
              UI.println(text)
              UI.empty()
            }

            if (part.type === "reasoning" && part.time?.end && args.thinking) {
              if (emit("reasoning", { part })) continue
              const text = part.text.trim()
              if (!text) continue
              const line = `Thinking: ${text}`
              if (process.stdout.isTTY) {
                UI.empty()
                UI.println(`${UI.Style.TEXT_DIM}\u001b[3m${line}\u001b[0m${UI.Style.TEXT_NORMAL}`)
                UI.empty()
                continue
              }
              process.stdout.write(line + EOL)
            }
          }

          if (event.type === "session.error") {
            const props = event.properties
            if (!props.sessionID || !active.has(props.sessionID) || !props.error) continue
            let err = String(props.error.name)
            if ("data" in props.error && props.error.data && "message" in props.error.data) {
              err = String(props.error.data.message)
            }
            error = error ? error + EOL + err : err
            if (emit("error", { error: props.error })) continue
            UI.error(err)
          }

          if (
            event.type === "session.status" &&
            active.has(event.properties.sessionID) &&
            event.properties.status.type === "idle"
          ) {
            toggles.delete(`start:${event.properties.sessionID}`)
            unlisten(event.properties.sessionID)
          }

          if (event.type === "permission.asked") {
            const permission = event.properties
            if (!active.has(permission.sessionID)) continue
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL +
                `permission requested: ${permission.permission} (${permission.patterns.join(", ")}); auto-rejecting`,
            )
            await sdk.permission.reply({
              requestID: permission.id,
              reply: "reject",
            })
          }

          if (event.type === "question.asked") {
            const question = event.properties
            if (!active.has(question.sessionID)) continue
            const waiter = waiters.get(question.sessionID)
            if (!waiter?.auto) continue
            if (question.questions[0]?.header !== "Build Agent") continue
            await sdk.question.reply({
              requestID: question.id,
              answers: [["Yes"]],
            })
          }
        }
      })()

      processor.catch((e) => {
        console.error(e)
        process.exit(1)
      })

      // Validate agent if specified
      const validated = await (async () => {
        if (!agent) return undefined

        // When attaching, validate against the running server instead of local Instance state.
        if (args.attach) {
          const modes = await sdk.app
            .agents(undefined, { throwOnError: true })
            .then((x) => x.data ?? [])
            .catch(() => undefined)

          if (!modes) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `failed to list agents from ${args.attach}. Falling back to default agent`,
            )
            return undefined
          }

          const entry = modes.find((item) => item.name === agent)
          if (!entry) {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${agent}" not found. Falling back to default agent`,
            )
            return undefined
          }

          if (entry.mode === "subagent") {
            UI.println(
              UI.Style.TEXT_WARNING_BOLD + "!",
              UI.Style.TEXT_NORMAL,
              `agent "${agent}" is a subagent, not a primary agent. Falling back to default agent`,
            )
            return undefined
          }

          return agent
        }

        const entry = await Agent.get(agent)
        if (!entry) {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${agent}" not found. Falling back to default agent`,
          )
          return undefined
        }
        if (entry.mode === "subagent") {
          UI.println(
            UI.Style.TEXT_WARNING_BOLD + "!",
            UI.Style.TEXT_NORMAL,
            `agent "${agent}" is a subagent, not a primary agent. Falling back to default agent`,
          )
          return undefined
        }
        return agent
      })()

      const sessionID = await session(sdk)
      if (!sessionID) {
        UI.error("Session not found")
        process.exit(1)
      }
      await share(sdk, sessionID)
      const auto = Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && isPlan(validated ?? "")

      // Start listening for the build session
      const idle = listen(sessionID, auto)

      if (args.command) {
        await sdk.session.command({
          sessionID,
          agent: validated,
          model: args.model,
          command: args.command,
          arguments: message,
          variant: args.variant,
        })
      } else {
        const model = args.model ? Provider.parseModel(args.model) : undefined
        await sdk.session.prompt({
          sessionID,
          agent: validated,
          model,
          variant: args.variant,
          parts: [...files, { type: "text", text: message }],
        })
      }

      // Wait for build to finish
      await idle

      // Run eval if enabled
      // Eval is on by default when implicit plan mode is active and no --agent was specified.
      // It can be explicitly enabled/disabled with --eval.
      const doEval = args.eval ?? (implicit && !args.agent)
      if (doEval && !error && !args.attach) {
        const maxIter = args.evalIterations ?? 5
        const model = args.model ? Provider.parseModel(args.model) : undefined

        UI.empty()
        UI.println(UI.Style.TEXT_INFO_BOLD + "~  " + UI.Style.TEXT_NORMAL + "Running eval...")

        const result = await Eval.run({
          sessionID: SessionID.make(sessionID),
          instruction: await Eval.extract(SessionID.make(sessionID), model),
          model,
          max: maxIter,
          onSession(sid) {
            // Register eval/build sessions so events are displayed
            active.add(sid)
            // Re-register the build session in case it was unlistened after idle
            active.add(sessionID)
          },
          onAttempt(attempt, max) {
            UI.empty()
            UI.println(UI.Style.TEXT_INFO_BOLD + `~  ` + UI.Style.TEXT_NORMAL + `Eval attempt ${attempt}/${max}`)
          },
          onResult(result) {
            if (result.pass) {
              UI.println(UI.Style.TEXT_INFO_BOLD + "✓  " + UI.Style.TEXT_NORMAL + "Eval passed: " + result.summary)
            } else {
              UI.println(
                UI.Style.TEXT_WARNING_BOLD + "✗  " + UI.Style.TEXT_NORMAL + "Eval found issues: " + result.summary,
              )
              if (result.issues?.length) {
                for (const issue of result.issues) {
                  const loc = issue.file ? ` (${issue.file})` : ""
                  UI.println(UI.Style.TEXT_DIM + `   [${issue.severity}]${loc}: ${issue.description}`)
                }
              }
            }
          },
        })

        if (!result.pass) {
          UI.empty()
          UI.println(
            UI.Style.TEXT_WARNING_BOLD +
              "!  " +
              UI.Style.TEXT_NORMAL +
              `Eval did not pass after ${result.attempt} attempt(s)`,
          )
        }
      }
    }

    if (args.attach) {
      const headers = (() => {
        const password = args.password ?? process.env.OPENCODE_SERVER_PASSWORD
        if (!password) return undefined
        const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
        const auth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`
        return { Authorization: auth }
      })()
      const sdk = createOpencodeClient({ baseUrl: args.attach, directory, headers })
      return await execute(sdk)
    }

    if (Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && isPlan(agent)) {
      process.env.OPENCODE_CLI_PLAN_AUTO_BUILD = "1"
    }

    try {
      await bootstrap(process.cwd(), async () => {
        const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init)
          return Server.Default().fetch(request)
        }) as typeof globalThis.fetch
        const sdk = createOpencodeClient({ baseUrl: "http://opencode.internal", fetch: fetchFn })
        await execute(sdk)
      })
    } finally {
      delete process.env.OPENCODE_CLI_PLAN_AUTO_BUILD
    }
  },
})
