import os from "os"
import path from "path"
import type { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Filesystem } from "@/util/filesystem"
import { Permission } from "@/permission"
import { get as getTmpdir } from "@/session/tmpdir"

type Kind = "file" | "directory"

type Options = {
  bypass?: boolean
  kind?: Kind
}

const ROOTS = [...new Set(["/tmp", "/private/tmp", os.tmpdir()].map((p) => p.replace(/\/+$/, "")))]
const nudged = new Map<string, Set<string>>()

function isSystemTemp(filepath: string) {
  return ROOTS.some((root) => Filesystem.contains(root, filepath))
}

function isSessionTemp(filepath: string, sessionID: string) {
  return Filesystem.contains(getTmpdir(sessionID), filepath)
}

export async function assertExternalDirectory(ctx: Tool.Context, target?: string, options?: Options) {
  if (!target) return

  if (options?.bypass) return

  const full = process.platform === "win32" ? Filesystem.normalizePath(target) : target
  if (Instance.containsPath(full)) return

  const kind = options?.kind ?? "file"
  const dir = kind === "directory" ? full : path.dirname(full)
  const glob =
    process.platform === "win32"
      ? Filesystem.normalizePathPattern(path.join(dir, "*"))
      : path.join(dir, "*").replaceAll("\\", "/")

  // Auto-reject system temp directory access when the agent has a session temp dir.
  // Skip this when the path is already inside the session temp dir (whitelisted),
  // or when the permission rules explicitly allow it.
  if (isSystemTemp(full) && !isSessionTemp(full, ctx.sessionID) && ctx.ruleset) {
    const rule = Permission.evaluate("external_directory", glob, ctx.ruleset)
    if (rule.action !== "allow") {
      const set = nudged.get(ctx.sessionID) ?? new Set()
      if (!set.has(glob)) {
        set.add(glob)
        nudged.set(ctx.sessionID, set)
        const dir = getTmpdir(ctx.sessionID)
        throw new Error(
          `You do not have permission to access the system temp directory. ` +
            `Use your temp workspace directory instead: ${dir}\n` +
            `If you specifically need the system temp directory, rerun this tool call and wait for the user to approve.`,
        )
      }
      // Retry: fall through to the normal permission dialog below
    } else {
      // Rules explicitly allow — proceed without nudge
      return
    }
  }

  await ctx.ask({
    permission: "external_directory",
    patterns: [glob],
    always: [glob],
    metadata: {
      filepath: full,
      parentDir: dir,
    },
  })
}

/** Clear auto-reject state for a session (call on session disposal). */
export function clearNudged(sessionID: string) {
  nudged.delete(sessionID)
}
