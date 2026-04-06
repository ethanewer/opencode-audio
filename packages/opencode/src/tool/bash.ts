import z from "zod"
import os from "os"
import { Tool } from "./tool"
import path from "path"
import fs from "fs"
import DESCRIPTION from "./bash.txt"
import { Log } from "../util/log"
import { Instance } from "../project/instance"
import { lazy } from "@/util/lazy"
import { Language, type Node } from "web-tree-sitter"

import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { fileURLToPath } from "url"
import { Flag } from "@/flag/flag"
import { Shell } from "@/shell/shell"

import { BashArity } from "@/permission/arity"
import { Truncate } from "./truncate"
import { ToolID } from "./schema"
import { TRUNCATION_DIR } from "./truncation-dir"
import { Plugin } from "@/plugin"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import * as CrossSpawnSpawner from "@/effect/cross-spawn-spawner"

const runtime = ManagedRuntime.make(CrossSpawnSpawner.defaultLayer)

const MAX_METADATA_LENGTH = 30_000
const DEFAULT_TIMEOUT = Flag.OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS || 2 * 60 * 1000
const SENTINEL_PREFIX = "__OC_META__:"

function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

function sessionStateFile(sessionID: string): string {
  const safe = sessionID.replace(/[^a-zA-Z0-9_-]/g, "_")
  return `/tmp/.opencode-shell-state-${safe}`
}

function wrapCommand(command: string, sessionID: string, workdir?: string): string {
  const sf = sessionStateFile(sessionID)
  const lines = [
    `__oc_sf=${sq(sf)}`,
    `[ -f "$__oc_sf" ] && . "$__oc_sf" 2>/dev/null`,
  ]
  if (workdir) {
    lines.push(`cd -- ${sq(workdir)} 2>/dev/null || true`)
  }
  lines.push(
    command,
    `__oc_rc=$?`,
    `{ printf 'cd -- %q\\n' "$(pwd)"; export -p; } > "$__oc_sf" 2>/dev/null`,
    `printf '\\n${SENTINEL_PREFIX}%d:%s\\n' "$__oc_rc" "$(pwd)"`,
    `exit $__oc_rc`,
  )
  return lines.join("\n")
}

function parseSentinel(output: string): { cleanOutput: string; exitCode: number | null; cwd: string | null } {
  const lines = output.split("\n")
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
    if (lines[i].startsWith(SENTINEL_PREFIX)) {
      const rest = lines[i].slice(SENTINEL_PREFIX.length)
      const colonIdx = rest.indexOf(":")
      const exitCode = parseInt(colonIdx >= 0 ? rest.slice(0, colonIdx) : rest, 10)
      const cwd = colonIdx >= 0 ? rest.slice(colonIdx + 1) : null
      let end = i
      while (end > 0 && lines[end - 1] === "") end--
      const cleanOutput = lines.slice(0, end).join("\n")
      return { cleanOutput, exitCode: isNaN(exitCode) ? null : exitCode, cwd }
    }
  }
  return { cleanOutput: output, exitCode: null, cwd: null }
}

function headTailTruncate(text: string, maxLines: number, maxBytes: number): { content: string; truncated: boolean; omitted: number } {
  const lines = text.split("\n")
  const totalBytes = Buffer.byteLength(text, "utf-8")
  if (lines.length <= maxLines && totalBytes <= maxBytes) {
    return { content: text, truncated: false, omitted: 0 }
  }
  const headLinesBudget = Math.max(1, Math.floor(maxLines * 0.2))
  const tailLinesBudget = Math.max(1, maxLines - headLinesBudget)
  const headBytesBudget = Math.floor(maxBytes * 0.2)
  const tailBytesBudget = maxBytes - headBytesBudget

  const head: string[] = []
  let headBytes = 0
  for (let i = 0; i < lines.length && head.length < headLinesBudget; i++) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (head.length > 0 ? 1 : 0)
    if (headBytes + size > headBytesBudget) break
    head.push(lines[i])
    headBytes += size
  }
  const tail: string[] = []
  let tailBytes = 0
  for (let i = lines.length - 1; i >= 0 && tail.length < tailLinesBudget; i--) {
    const size = Buffer.byteLength(lines[i], "utf-8") + (tail.length > 0 ? 1 : 0)
    if (tailBytes + size > tailBytesBudget) break
    tail.unshift(lines[i])
    tailBytes += size
  }
  const omitted = lines.length - head.length - tail.length
  if (omitted <= 0) return { content: text, truncated: false, omitted: 0 }
  return {
    content: [...head, `\n... ${omitted} lines omitted ...\n`, ...tail].join("\n"),
    truncated: true,
    omitted,
  }
}

async function writeLogFile(data: { cwd: string; command: string; startTime: Date; endTime: Date; exitCode: number | null; output: string }): Promise<string> {
  const logPath = path.join(TRUNCATION_DIR, ToolID.ascending())
  await fs.promises.mkdir(TRUNCATION_DIR, { recursive: true })
  const duration = data.endTime.getTime() - data.startTime.getTime()
  const content = [
    `=== SHELL COMMAND LOG ===`,
    `cwd: ${data.cwd}`,
    `command: ${data.command}`,
    `start_time: ${data.startTime.toISOString()}`,
    `end_time: ${data.endTime.toISOString()}`,
    `exit_code: ${data.exitCode ?? "unknown"}`,
    `duration_ms: ${duration}`,
    `===`,
    data.output,
  ].join("\n")
  await fs.promises.writeFile(logPath, content, "utf-8")
  return logPath
}
const PS = new Set(["powershell", "pwsh"])
const CWD = new Set(["cd", "push-location", "set-location"])
const FILES = new Set([
  ...CWD,
  "rm",
  "cp",
  "mv",
  "mkdir",
  "touch",
  "chmod",
  "chown",
  "cat",
  // Leave PowerShell aliases out for now. Common ones like cat/cp/mv/rm/mkdir
  // already hit the entries above, and alias normalization should happen in one
  // place later so we do not risk double-prompting.
  "get-content",
  "set-content",
  "add-content",
  "copy-item",
  "move-item",
  "remove-item",
  "new-item",
  "rename-item",
])
const FLAGS = new Set(["-destination", "-literalpath", "-path"])
const SWITCHES = new Set(["-confirm", "-debug", "-force", "-nonewline", "-recurse", "-verbose", "-whatif"])

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

export const log = Log.create({ service: "bash-tool" })

const resolveWasm = (asset: string) => {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

function parts(node: Node) {
  const out: Part[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i)
    if (!child) continue
    if (child.type === "command_elements") {
      for (let j = 0; j < child.childCount; j++) {
        const item = child.child(j)
        if (!item || item.type === "command_argument_sep" || item.type === "redirection") continue
        out.push({ type: item.type, text: item.text })
      }
      continue
    }
    if (
      child.type !== "command_name" &&
      child.type !== "command_name_expr" &&
      child.type !== "word" &&
      child.type !== "string" &&
      child.type !== "raw_string" &&
      child.type !== "concatenation"
    ) {
      continue
    }
    out.push({ type: child.type, text: child.text })
  }
  return out
}

function source(node: Node) {
  return (node.parent?.type === "redirected_statement" ? node.parent.text : node.text).trim()
}

function commands(node: Node) {
  return node.descendantsOfType("command").filter((child): child is Node => Boolean(child))
}

function unquote(text: string) {
  if (text.length < 2) return text
  const first = text[0]
  const last = text[text.length - 1]
  if ((first === '"' || first === "'") && first === last) return text.slice(1, -1)
  return text
}

function home(text: string) {
  if (text === "~") return os.homedir()
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2))
  return text
}

function envValue(key: string) {
  if (process.platform !== "win32") return process.env[key]
  const name = Object.keys(process.env).find((item) => item.toLowerCase() === key.toLowerCase())
  return name ? process.env[name] : undefined
}

function auto(key: string, cwd: string, shell: string) {
  const name = key.toUpperCase()
  if (name === "HOME") return os.homedir()
  if (name === "PWD") return cwd
  if (name === "PSHOME") return path.dirname(shell)
}

function expand(text: string, cwd: string, shell: string) {
  const out = unquote(text)
    .replace(/\$\{env:([^}]+)\}/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, key: string) => envValue(key) || "")
    .replace(/\$(HOME|PWD|PSHOME)(?=$|[\\/])/gi, (_, key: string) => auto(key, cwd, shell) || "")
  return home(out)
}

function provider(text: string) {
  const match = text.match(/^([A-Za-z]+)::(.*)$/)
  if (match) {
    if (match[1].toLowerCase() !== "filesystem") return
    return match[2]
  }
  const prefix = text.match(/^([A-Za-z]+):(.*)$/)
  if (!prefix) return text
  if (prefix[1].length === 1) return text
  return
}

function dynamic(text: string, ps: boolean) {
  if (text.startsWith("(") || text.startsWith("@(")) return true
  if (text.includes("$(") || text.includes("${") || text.includes("`")) return true
  if (ps) return /\$(?!env:)/i.test(text)
  return text.includes("$")
}

function prefix(text: string) {
  const match = /[?*\[]/.exec(text)
  if (!match) return text
  if (match.index === 0) return
  return text.slice(0, match.index)
}

async function cygpath(shell: string, text: string) {
  const out = await Process.text([shell, "-lc", 'cygpath -w -- "$1"', "_", text], { nothrow: true })
  if (out.code !== 0) return
  const file = out.text.trim()
  if (!file) return
  return Filesystem.normalizePath(file)
}

async function resolvePath(text: string, root: string, shell: string) {
  if (process.platform === "win32") {
    if (Shell.posix(shell) && text.startsWith("/") && Filesystem.windowsPath(text) === text) {
      const file = await cygpath(shell, text)
      if (file) return file
    }
    return Filesystem.normalizePath(path.resolve(root, Filesystem.windowsPath(text)))
  }
  return path.resolve(root, text)
}

async function argPath(arg: string, cwd: string, ps: boolean, shell: string) {
  const text = ps ? expand(arg, cwd, shell) : home(unquote(arg))
  const file = text && prefix(text)
  if (!file || dynamic(file, ps)) return
  const next = ps ? provider(file) : file
  if (!next) return
  return resolvePath(next, cwd, shell)
}

function pathArgs(list: Part[], ps: boolean) {
  if (!ps) {
    return list
      .slice(1)
      .filter((item) => !item.text.startsWith("-") && !(list[0]?.text === "chmod" && item.text.startsWith("+")))
      .map((item) => item.text)
  }

  const out: string[] = []
  let want = false
  for (const item of list.slice(1)) {
    if (want) {
      out.push(item.text)
      want = false
      continue
    }
    if (item.type === "command_parameter") {
      const flag = item.text.toLowerCase()
      if (SWITCHES.has(flag)) continue
      want = FLAGS.has(flag)
      continue
    }
    out.push(item.text)
  }
  return out
}

async function collect(root: Node, cwd: string, ps: boolean, shell: string): Promise<Scan> {
  const scan: Scan = {
    dirs: new Set<string>(),
    patterns: new Set<string>(),
    always: new Set<string>(),
  }

  for (const node of commands(root)) {
    const command = parts(node)
    const tokens = command.map((item) => item.text)
    const cmd = ps ? tokens[0]?.toLowerCase() : tokens[0]

    if (cmd && FILES.has(cmd)) {
      for (const arg of pathArgs(command, ps)) {
        const resolved = await argPath(arg, cwd, ps, shell)
        log.info("resolved path", { arg, resolved })
        if (!resolved || Instance.containsPath(resolved)) continue
        const dir = (await Filesystem.isDir(resolved)) ? resolved : path.dirname(resolved)
        scan.dirs.add(dir)
      }
    }

    if (tokens.length && (!cmd || !CWD.has(cmd))) {
      scan.patterns.add(source(node))
      scan.always.add(BashArity.prefix(tokens).join(" ") + " *")
    }
  }

  return scan
}

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return text.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
}

async function parse(command: string, ps: boolean) {
  const tree = await parser().then((p) => (ps ? p.ps : p.bash).parse(command))
  if (!tree) throw new Error("Failed to parse command")
  return tree.rootNode
}

async function ask(ctx: Tool.Context, scan: Scan) {
  if (scan.dirs.size > 0) {
    const globs = Array.from(scan.dirs).map((dir) => {
      if (process.platform === "win32") return Filesystem.normalizePathPattern(path.join(dir, "*"))
      return path.join(dir, "*")
    })
    await ctx.ask({
      permission: "external_directory",
      patterns: globs,
      always: globs,
      metadata: {},
    })
  }

  if (scan.patterns.size === 0) return
  await ctx.ask({
    permission: "bash",
    patterns: Array.from(scan.patterns),
    always: Array.from(scan.always),
    metadata: {},
  })
}

async function shellEnv(ctx: Tool.Context, cwd: string) {
  const extra = await Plugin.trigger("shell.env", { cwd, sessionID: ctx.sessionID, callID: ctx.callID }, { env: {} })
  return {
    ...process.env,
    ...extra.env,
  }
}

function cmd(shell: string, name: string, command: string, cwd: string, env: NodeJS.ProcessEnv) {
  if (process.platform === "win32" && PS.has(name)) {
    return ChildProcess.make(shell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      cwd,
      env,
      stdin: "ignore",
      detached: false,
    })
  }

  return ChildProcess.make(command, [], {
    shell,
    cwd,
    env,
    stdin: "ignore",
    detached: process.platform !== "win32",
  })
}

async function run(
  input: {
    shell: string
    name: string
    command: string
    cwd: string
    env: NodeJS.ProcessEnv
    timeout: number
    description: string
    sessionID: string
    workdir?: string
  },
  ctx: Tool.Context,
) {
  let output = ""
  let expired = false
  let aborted = false
  const startTime = new Date()

  const ps = PS.has(input.name)
  const execCommand = ps ? input.command : wrapCommand(input.command, input.sessionID, input.workdir)

  ctx.metadata({
    metadata: {
      output: "",
      description: input.description,
    },
  })

  const exit = await runtime.runPromiseExit(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const handle = yield* spawner.spawn(cmd(input.shell, input.name, execCommand, input.cwd, input.env))

      yield* Effect.forkScoped(
        Stream.runForEach(Stream.decodeText(handle.all), (chunk) =>
          Effect.sync(() => {
            output += chunk
            ctx.metadata({
              metadata: {
                output: preview(output),
                description: input.description,
              },
            })
          }),
        ),
      )

      const abort = Effect.callback<void>((resume) => {
        if (ctx.abort.aborted) return resume(Effect.void)
        const handler = () => resume(Effect.void)
        ctx.abort.addEventListener("abort", handler, { once: true })
        return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
      })

      const timeout = Effect.sleep(`${input.timeout + 100} millis`)

      const result = yield* Effect.raceAll([
        handle.exitCode.pipe(Effect.map((code) => ({ kind: "exit" as const, code }))),
        abort.pipe(Effect.map(() => ({ kind: "abort" as const, code: null }))),
        timeout.pipe(Effect.map(() => ({ kind: "timeout" as const, code: null }))),
      ])

      if (result.kind === "abort") {
        aborted = true
        yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
      }
      if (result.kind === "timeout") {
        expired = true
        yield* handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.orDie)
      }

      return result.kind === "exit" ? result.code : null
    }).pipe(Effect.scoped, Effect.orDie),
  )

  const endTime = new Date()
  let processExitCode: number | null = null
  if (Exit.isSuccess(exit)) {
    processExitCode = exit.value
  } else if (!Cause.hasInterruptsOnly(exit.cause)) {
    throw Cause.squash(exit.cause)
  }

  let cleanOutput = output
  let shellCwd = input.cwd
  let shellExitCode = processExitCode

  if (!ps) {
    const parsed = parseSentinel(output)
    cleanOutput = parsed.cleanOutput
    if (parsed.exitCode !== null) shellExitCode = parsed.exitCode
    if (parsed.cwd) shellCwd = parsed.cwd
  }

  if (expired) cleanOutput += `\n\nCommand timed out after ${input.timeout}ms`
  if (aborted) cleanOutput += "\n\nCommand aborted"

  let logPath: string | undefined
  try {
    logPath = await writeLogFile({
      cwd: shellCwd,
      command: input.command,
      startTime,
      endTime,
      exitCode: shellExitCode,
      output: cleanOutput,
    })
  } catch {
    log.warn("failed to write command log file")
  }

  const headerLines = [
    `[cwd: ${shellCwd}] $ ${input.command}`,
    `Exit code: ${shellExitCode ?? "unknown"}`,
  ]
  if (logPath) headerLines.push(`Log: ${logPath}`)
  const header = headerLines.join("\n")

  const trunc = headTailTruncate(cleanOutput, Truncate.MAX_LINES, Truncate.MAX_BYTES)
  const formattedOutput = trunc.truncated
    ? `${header}\n\n${trunc.content}${logPath ? `\n\n(Full output saved to ${logPath})` : ""}`
    : `${header}\n\n${cleanOutput}`

  return {
    title: input.description,
    metadata: {
      output: preview(cleanOutput),
      exit: shellExitCode,
      description: input.description,
      cwd: shellCwd,
      logPath,
      truncated: trunc.truncated,
    },
    output: formattedOutput,
  }
}

const parser = lazy(async () => {
  const { Parser } = await import("web-tree-sitter")
  const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
    with: { type: "wasm" },
  })
  const treePath = resolveWasm(treeWasm)
  await Parser.init({
    locateFile() {
      return treePath
    },
  })
  const { default: bashWasm } = await import("tree-sitter-bash/tree-sitter-bash.wasm" as string, {
    with: { type: "wasm" },
  })
  const { default: psWasm } = await import("tree-sitter-powershell/tree-sitter-powershell.wasm" as string, {
    with: { type: "wasm" },
  })
  const bashPath = resolveWasm(bashWasm)
  const psPath = resolveWasm(psWasm)
  const [bashLanguage, psLanguage] = await Promise.all([Language.load(bashPath), Language.load(psPath)])
  const bash = new Parser()
  bash.setLanguage(bashLanguage)
  const ps = new Parser()
  ps.setLanguage(psLanguage)
  return { bash, ps }
})

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define("bash", async () => {
  const shell = Shell.acceptable()
  const name = Shell.name(shell)
  const chain =
    name === "powershell"
      ? "If the commands depend on each other and must run sequentially, avoid '&&' in this shell because Windows PowerShell 5.1 does not support it. Use PowerShell conditionals such as `cmd1; if ($?) { cmd2 }` when later commands must depend on earlier success."
      : "If the commands depend on each other and must run sequentially, use a single Bash call with '&&' to chain them together (e.g., `git add . && git commit -m \"message\" && git push`). For instance, if one operation must complete before another starts (like mkdir before cp, Write before Bash for git operations, or git add before git commit), run these operations sequentially instead."
  log.info("bash tool using shell", { shell })

  return {
    description: DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${os}", process.platform)
      .replaceAll("${shell}", name)
      .replaceAll("${chaining}", chain),
    parameters: z.object({
      command: z.string().describe("The command to execute"),
      timeout: z.number().describe("Optional timeout in milliseconds").optional(),
      workdir: z
        .string()
        .describe(
          `The working directory to run the command in. Defaults to ${Instance.directory}. Use this instead of 'cd' commands.`,
        )
        .optional(),
      description: z
        .string()
        .describe(
          "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
        ),
    }),
    async execute(params, ctx) {
      const resolvedWorkdir = params.workdir ? await resolvePath(params.workdir, Instance.directory, shell) : undefined
      const permCwd = resolvedWorkdir ?? Instance.directory
      if (params.timeout !== undefined && params.timeout < 0) {
        throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
      }
      const timeout = params.timeout ?? DEFAULT_TIMEOUT
      const ps = PS.has(name)
      const root = await parse(params.command, ps)
      const scan = await collect(root, permCwd, ps, shell)
      if (!Instance.containsPath(permCwd)) scan.dirs.add(permCwd)
      await ask(ctx, scan)

      return run(
        {
          shell,
          name,
          command: params.command,
          cwd: Instance.directory,
          env: await shellEnv(ctx, Instance.directory),
          timeout,
          description: params.description,
          sessionID: ctx.sessionID,
          workdir: resolvedWorkdir,
        },
        ctx,
      )
    },
  }
})
