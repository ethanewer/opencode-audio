// Detect write/patch heredoc patterns in shell keystrokes so the TUI can
// show proper diff/new-file views. Runs best-effort — if parsing fails we
// return no effects and the call renders as a plain shell invocation.

import path from "path"
import { createTwoFilesPatch } from "diff"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

const log = Log.create({ service: "shell-detect" })

export type FileEffect = {
  kind: "write" | "patch"
  path: string
  diff?: string
  additions: number
  deletions: number
  ok: boolean
}

// `write /abs/path <<'TAG'` or `write /abs/path <<TAG`
const WRITE_HEREDOC =
  /(?:^|[\r\n])[ \t]*write[ \t]+(\S+)[ \t]+<<-?[ \t]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\r?\n|$)/g

// `patch [--all] <path> <<'TAG'` or `patch [--all] <path> <<TAG`.
// Optionally one or more leading flag tokens, then required path, then the
// heredoc delimiter.
const PATCH_HEREDOC =
  /(?:^|[\r\n])[ \t]*patch(?:[ \t]+--[A-Za-z0-9-]+)*[ \t]+(\S+)[ \t]*<<-?[ \t]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\r?\n|$)/g

function resolveAbs(p: string) {
  if (path.isAbsolute(p)) return p
  return path.resolve(Instance.directory, p)
}

function countChanges(diff: string) {
  let additions = 0
  let deletions = 0
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions++
    else if (line.startsWith("-") && !line.startsWith("---")) deletions++
  }
  return { additions, deletions }
}

type Block = { old: string; next: string }

/**
 * Parse a search/replace body into blocks. Returns null when the body is
 * malformed (missing '===' or '>>>') or contains stray non-block content.
 */
function parseBlocks(body: string): Block[] | null {
  const lines = body.split("\n")
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const trimmed = lines[i].replace(/[ \t]+$/, "")
    if (trimmed === "<<<") {
      let sep = -1
      let end = -1
      for (let j = i + 1; j < lines.length; j++) {
        const s = lines[j].replace(/[ \t]+$/, "")
        if (s === "===" && sep < 0) sep = j
        else if (s === ">>>") {
          end = j
          break
        }
      }
      if (sep < 0 || end < 0) return null
      blocks.push({
        old: lines.slice(i + 1, sep).join("\n"),
        next: lines.slice(sep + 1, end).join("\n"),
      })
      i = end + 1
    } else if (trimmed === "") {
      i++
    } else {
      return null
    }
  }
  return blocks.length > 0 ? blocks : null
}

function applyBlocks(content: string, blocks: Block[]): string | null {
  let out = content
  for (const b of blocks) {
    if (b.old === "") {
      out = b.next + out
      continue
    }
    const idx = out.indexOf(b.old)
    if (idx < 0) return null
    out = out.slice(0, idx) + b.next + out.slice(idx + b.old.length)
  }
  return out
}

async function writeEffect(p: string, content: string): Promise<FileEffect> {
  const abs = resolveAbs(p)
  const existing = (await Filesystem.exists(abs)) ? await Filesystem.readText(abs).catch(() => "") : ""
  const diff = createTwoFilesPatch(abs, abs, existing, content)
  const { additions, deletions } = countChanges(diff)
  return { kind: "write", path: abs, diff, additions, deletions, ok: true }
}

async function patchEffect(filePath: string, body: string): Promise<FileEffect> {
  const abs = resolveAbs(filePath)
  const existing = (await Filesystem.exists(abs)) ? await Filesystem.readText(abs).catch(() => "") : ""
  const blocks = parseBlocks(body)
  if (!blocks) {
    return { kind: "patch", path: abs, diff: body, additions: 0, deletions: 0, ok: false }
  }
  const next = applyBlocks(existing, blocks)
  if (next === null) {
    return { kind: "patch", path: abs, diff: body, additions: 0, deletions: 0, ok: false }
  }
  const diff = createTwoFilesPatch(abs, abs, existing, next)
  const { additions, deletions } = countChanges(diff)
  return { kind: "patch", path: abs, diff, additions, deletions, ok: true }
}

/**
 * Scan the commands for write/patch heredoc patterns and return the implied
 * file effects. Returns [] when nothing matches. Order matches the order the
 * commands will execute in, so the TUI can render them as a single sequence.
 */
export async function detectFileEffects(commands: string[], _cwd: string): Promise<FileEffect[]> {
  const out: FileEffect[] = []
  for (const cmd of commands) {
    if (!cmd) continue
    WRITE_HEREDOC.lastIndex = 0
    for (const m of cmd.matchAll(WRITE_HEREDOC)) {
      try {
        out.push(await writeEffect(m[1], m[3] ?? ""))
      } catch (err) {
        log.info("write detect failed", { err: String(err) })
      }
    }
    PATCH_HEREDOC.lastIndex = 0
    for (const m of cmd.matchAll(PATCH_HEREDOC)) {
      try {
        out.push(await patchEffect(m[1], m[3] ?? ""))
      } catch (err) {
        log.info("patch detect failed", { err: String(err) })
      }
    }
  }
  return out
}
