// Detect write/patch heredoc patterns in shell keystrokes so the TUI can show
// proper diff/new-file views. Runs best-effort — if parsing fails we simply
// return no effects and the call renders as a plain shell invocation.

import path from "path"
import { applyPatch, createTwoFilesPatch, parsePatch } from "diff"
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

// Match `write /abs/path <<'TAG'` or `write /abs/path <<TAG` on its own line.
// Using multiline mode so ^ anchors to any newline. `$2` in replacement
// unused here — we use the trailing backreference `\2` to find the delimiter.
const WRITE_HEREDOC = /(?:^|[\r\n])[ \t]*write[ \t]+(\S+)[ \t]+<<-?[ \t]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?=\r?\n|$)/g

// Match `patch ...flags... <<'TAG'` or `patch ...flags... <<TAG`
const PATCH_HEREDOC = /(?:^|[\r\n])[ \t]*patch(?:[ \t]+-[A-Za-z0-9-]+)*[ \t]*<<-?[ \t]*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[ \t]*\n([\s\S]*?)\n[ \t]*\1[ \t]*(?=\r?\n|$)/g

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

async function writeEffect(p: string, content: string): Promise<FileEffect> {
  const abs = resolveAbs(p)
  const existing = (await Filesystem.exists(abs)) ? await Filesystem.readText(abs).catch(() => "") : ""
  const diff = createTwoFilesPatch(abs, abs, existing, content)
  const { additions, deletions } = countChanges(diff)
  return {
    kind: "write",
    path: abs,
    diff,
    additions,
    deletions,
    ok: true,
  }
}

async function patchEffect(patchText: string): Promise<FileEffect[]> {
  let parsed
  try {
    parsed = parsePatch(patchText)
  } catch (err) {
    log.info("patch parse failed", { err: String(err) })
    return []
  }
  const out: FileEffect[] = []
  for (const p of parsed) {
    // Prefer the "+++" header when present, else "---"
    const target = p.newFileName || p.oldFileName || ""
    if (!target) continue
    // Strip leading "a/" or "b/" if the model produced git-style diff
    const clean = target.replace(/^[ab]\//, "").trim()
    if (!clean) continue
    const abs = resolveAbs(clean)
    let existing = ""
    if (await Filesystem.exists(abs)) {
      existing = await Filesystem.readText(abs).catch(() => "")
    }
    const applied = applyPatch(existing, p as any)
    const ok = typeof applied === "string"
    let diff: string
    let additions = 0
    let deletions = 0
    if (ok) {
      diff = createTwoFilesPatch(abs, abs, existing, applied as string)
      const counts = countChanges(diff)
      additions = counts.additions
      deletions = counts.deletions
    } else {
      // Render the raw patch so the TUI still shows something useful
      diff = patchText
      const counts = countChanges(diff)
      additions = counts.additions
      deletions = counts.deletions
    }
    out.push({
      kind: "patch",
      path: abs,
      diff,
      additions,
      deletions,
      ok,
    })
  }
  return out
}

/**
 * Scan the commands for write/patch heredoc patterns and return the implied
 * file effects. Safe to call on unrelated commands — returns [] when nothing
 * matches. Order of effects matches the order commands will execute, so the
 * TUI can render them as a single sequence.
 */
export async function detectFileEffects(commands: string[], _cwd: string): Promise<FileEffect[]> {
  const out: FileEffect[] = []
  for (const cmd of commands) {
    if (!cmd) continue
    // write heredocs
    WRITE_HEREDOC.lastIndex = 0
    for (const m of cmd.matchAll(WRITE_HEREDOC)) {
      const p = m[1]
      const body = m[3] ?? ""
      try {
        out.push(await writeEffect(p, body))
      } catch (err) {
        log.info("write detect failed", { err: String(err) })
      }
    }
    // patch heredocs
    PATCH_HEREDOC.lastIndex = 0
    for (const m of cmd.matchAll(PATCH_HEREDOC)) {
      const body = m[2] ?? ""
      try {
        const effects = await patchEffect(body)
        for (const e of effects) out.push(e)
      } catch (err) {
        log.info("patch detect failed", { err: String(err) })
      }
    }
  }
  return out
}
