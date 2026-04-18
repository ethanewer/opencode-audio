import z from "zod"
import os from "os"
import path from "path"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Tmux } from "@/tmux/tmux"
import { Language, type Node } from "web-tree-sitter"
import { lazy } from "@/util/lazy"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { fileURLToPath } from "url"
import { Shell } from "@/shell/shell"
import { BashArity } from "@/permission/arity"
import { TodoGate } from "../session/todo-gate"

const log = Log.create({ service: "shell-tool" })
const MAX_OUTPUT_BYTES = 30_000
const MAX_METADATA_LENGTH = 30_000

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

/** Tmux escape sequences that are not real shell commands. */
const TMUX_ESCAPE =
  /^(C-[a-zA-Z]|Escape|Tab|BTab|Up|Down|Left|Right|Home|End|PageUp|PageDown|BSpace|DC|IC|F[0-9]+|[SM]-\S+)$/

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return text.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
}

function limit(text: string) {
  if (text.length <= MAX_OUTPUT_BYTES) return text
  const half = Math.floor(MAX_OUTPUT_BYTES / 2)
  return text.slice(0, half) + `\n\n... (${text.length - MAX_OUTPUT_BYTES} bytes truncated) ...\n\n` + text.slice(-half)
}

type Part = {
  type: string
  text: string
}

type Scan = {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

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

  // Detect bare redirections (e.g., "> file.txt") which have no command node
  for (const node of root.descendantsOfType("redirected_statement")) {
    if (!node || commands(node).length > 0) continue
    scan.patterns.add(node.text.trim())
  }

  return scan
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

/**
 * Classify a full shell command line as "read-only" or "side-effect" by
 * parsing it with tree-sitter and evaluating each sub-command against the
 * shared read-only bash ruleset (the same rules the plan agent uses to
 * restrict shell). A line is read-only only if EVERY sub-command resolves
 * to "allow" under that ruleset. Parse failures or unknown commands are
 * conservatively classified as side-effect.
 */
async function classifyLine(text: string): Promise<"read-only" | "side-effect"> {
  const shellBin = Shell.acceptable()
  const name = Shell.name(shellBin)
  const ps = PS.has(name)
  let root: Node
  try {
    root = await parse(text, ps)
  } catch {
    return "side-effect"
  }

  // Output redirections are always side effects; the permission rules already
  // deny "* > *" / "* >> *", but redirection nodes with no command attached
  // won't show up in commands(root).
  for (const node of root.descendantsOfType("redirected_statement")) {
    if (!node) continue
    const raw = node.text
    if (/(^|\s)(>{1,2})\s*\S/.test(raw)) return "side-effect"
  }

  const commandNodes = commands(root)
  if (commandNodes.length === 0) {
    // No recognized command — could be a bare variable assignment, a
    // here-doc, or unparseable junk. Conservative default: side-effect.
    return "side-effect"
  }

  for (const node of commandNodes) {
    const tokens = parts(node).map((item) => item.text)
    if (tokens.length === 0) return "side-effect"
    // Use the raw source form so deny rules like "* > *" can fire. Wildcard
    // patterns like "grep *" match bare "grep" because the trailing " *" is
    // made optional by the wildcard matcher.
    const raw = source(node)
    if (TodoGate.classifyShell(raw) === "side-effect") return "side-effect"
  }
  return "read-only"
}

/**
 * Parse a shell command string, check for external directories and bash
 * permission rules using tree-sitter analysis. When every rule resolves to
 * "allow", this is a no-op (the permission.ask calls return immediately
 * without prompting the user).
 */
async function checkCommandPermissions(text: string, cwd: string, ctx: Tool.Context): Promise<void> {
  const shell = Shell.acceptable()
  const name = Shell.name(shell)
  const ps = PS.has(name)

  const merged: Scan = {
    dirs: new Set<string>(),
    patterns: new Set<string>(),
    always: new Set<string>(),
  }

  if (text) {
    try {
      const root = await parse(text, ps)
      const scan = await collect(root, cwd, ps, shell)
      for (const dir of scan.dirs) merged.dirs.add(dir)
      for (const p of scan.patterns) merged.patterns.add(p)
      for (const a of scan.always) merged.always.add(a)
    } catch {
      // If tree-sitter cannot parse the text (special keys, partial input,
      // interactive prompts like "y"), fall back to a raw pattern so the
      // permission system can still evaluate it.
      merged.patterns.add(text)
      merged.always.add(text + " *")
    }
  }

  if (!Instance.containsPath(cwd)) merged.dirs.add(cwd)
  await ask(ctx, merged)
}

import SHELL_DESCRIPTION from "./shell.txt"

const ShellParams = z.object({
  analysis: z
    .string()
    .describe(
      "Short analysis of the current terminal state and what you just observed. " +
        "What do you see? What has been accomplished? What still needs to be done?",
    ),
  plan: z
    .string()
    .describe(
      "Short plan for this batch of commands. What are you about to run and why? What outcome do you expect?",
    ),
  commands: z
    .array(
      z.object({
        keystrokes: z
          .string()
          .describe(
            "Keystrokes to send to the terminal. If the entire string matches a recognized key name (Escape, Tab, Up, Down, Left, Right, Home, End, PageUp, PageDown, BSpace, BTab, F1-F12, or C-/S-/M- modified keys like C-c, C-d), it is sent as that key press. Otherwise it is typed as literal text, and a newline is auto-appended if the string does not already end with one.",
          ),
        duration: z
          .number()
          .describe(
            "Seconds to wait for output after this command before the next begins. Default 1.0, max 600. On immediate commands (cd, ls, echo) use 0.1. On normal commands use 1.0. On slow commands (make, large tests, installs) use a larger value. You can always poll with empty keystrokes and a duration to wait longer.",
          )
          .optional(),
        literal: z
          .boolean()
          .describe(
            "Force literal text input. When true, recognized key names are typed as text instead of pressed, and no newline is auto-appended.",
          )
          .optional(),
      }),
    )
    .describe(
      "Commands to run. Each command's keystrokes are sent to the shared tmux session in order. The array may be empty to poll for more output from a prior call.",
    ),
  reset: z
    .boolean()
    .describe(
      "If true, kill the persistent terminal and start a fresh shell before sending commands. Use this only when the terminal is in an unrecoverable stuck state.",
    )
    .optional(),
})

type ShellMetadata = {
  output: string
  analysis: string
  plan: string
  commands: string[]
  truncated: boolean
  reset?: boolean
}

export const ShellTool = Tool.define<typeof ShellParams, ShellMetadata>("shell", {
  description: SHELL_DESCRIPTION,
  parameters: ShellParams,
  async execute(params, ctx) {
    const cwd = Instance.directory
    const commands = params.commands.map((c) => ({
      keystrokes: c.keystrokes,
      duration: Math.min(c.duration ?? 1.0, 600),
      literal: c.literal,
    }))
    const labels = commands.map((c) => c.keystrokes.replace(/\n$/, "").trim()).filter(Boolean)

    ctx.metadata({
      metadata: {
        output: "",
        analysis: params.analysis,
        plan: params.plan,
        commands: labels,
        truncated: false,
        reset: params.reset === true,
      },
    })

    // Todo gate: any side-effect command requires an in_progress todo with
    // populated notes. Empty keystrokes and tmux escape sequences are exempt.
    for (const label of labels) {
      if (!label || TMUX_ESCAPE.test(label)) continue
      const classification = await classifyLine(label)
      if (classification !== "side-effect") continue
      const gate = TodoGate.allow(ctx.sessionID, ctx.ruleset, ctx.agent)
      if (!gate.ok) {
        return {
          title: "shell blocked — no active plan",
          metadata: {
            output: "",
            analysis: params.analysis,
            plan: params.plan,
            commands: labels,
            truncated: false,
          },
          output: TodoGate.blockMessage("shell", gate.reason),
        }
      }
      break
    }

    // Permission checks. When every rule resolves to "allow" this returns
    // immediately without prompting.
    for (const label of labels) {
      if (!label || TMUX_ESCAPE.test(label)) continue
      await checkCommandPermissions(label, cwd, ctx)
    }

    if (params.reset) {
      await Tmux.kill(ctx.sessionID)
      log.info("reset shell", { sessionID: ctx.sessionID })
    }

    log.info("shell", { commands: labels.length, sessionID: ctx.sessionID })

    const output = await Tmux.execute(ctx.sessionID, cwd, commands, (partial) => {
      ctx.metadata({
        metadata: {
          output: preview(partial),
          analysis: params.analysis,
          plan: params.plan,
          commands: labels,
          truncated: false,
        },
      })
    })

    const limited = limit(output)
    const result = limited.trim()
      ? `[New output]\n${limited}`
      : `[No new output — showing current terminal]\n${limit((await Tmux.capture(ctx.sessionID)) || "(empty)")}`

    const title = params.plan.slice(0, 80) || labels[0]?.slice(0, 80) || "shell"

    return {
      title,
      metadata: {
        output: preview(output),
        analysis: params.analysis,
        plan: params.plan,
        commands: labels,
        truncated: output.length > MAX_OUTPUT_BYTES,
      },
      output: result,
    }
  },
})
