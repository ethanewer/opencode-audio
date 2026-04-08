import os from "os"
import path from "path"
import { mkdirSync } from "fs"

const BASE = path.join(os.tmpdir(), "opencode-sessions")
const cache = new Map<string, string>()

export const GLOB = path.join(BASE, "*")

export function get(sessionID: string): string {
  const existing = cache.get(sessionID)
  if (existing) return existing
  const dir = path.join(BASE, sessionID)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {}
  cache.set(sessionID, dir)
  return dir
}
