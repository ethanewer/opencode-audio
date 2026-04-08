import { test, expect } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs"
import { get, GLOB } from "../../src/session/tmpdir"

const BASE = path.join(os.tmpdir(), "opencode-sessions")

test("GLOB points to base with wildcard", () => {
  expect(GLOB).toBe(path.join(BASE, "*"))
})

test("get returns path under base dir", () => {
  const dir = get("session_test_abc")
  expect(dir).toBe(path.join(BASE, "session_test_abc"))
})

test("get creates the directory synchronously", () => {
  const id = "session_test_sync_" + Date.now()
  const dir = get(id)
  expect(fs.existsSync(dir)).toBe(true)
  fs.rmdirSync(dir)
})

test("get returns same path on repeated calls", () => {
  const id = "session_test_cache_" + Date.now()
  const a = get(id)
  const b = get(id)
  expect(a).toBe(b)
  try { fs.rmdirSync(a) } catch {}
})

test("get returns distinct paths for different sessions", () => {
  const a = get("session_test_distinct_a")
  const b = get("session_test_distinct_b")
  expect(a).not.toBe(b)
})
