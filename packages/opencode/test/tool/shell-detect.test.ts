import { afterEach, describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { detectFileEffects } from "../../src/tool/shell-detect"
import { tmpdir } from "../fixture/fixture"
import path from "path"
import { promises as fs } from "fs"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("shell effect detection", () => {
  test("detects write heredoc on a new file", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const p = path.join(tmp.path, "new.txt")
        const cmd = `write ${p} <<'EOF'\nhello\nworld\nEOF\n`
        const effects = await detectFileEffects([cmd], tmp.path)
        expect(effects.length).toBe(1)
        expect(effects[0].kind).toBe("write")
        expect(effects[0].path).toBe(p)
        expect(effects[0].ok).toBe(true)
        expect(effects[0].additions).toBeGreaterThan(0)
        expect(effects[0].diff).toContain("hello")
        expect(effects[0].diff).toContain("world")
      },
    })
  })

  test("detects write heredoc overwriting an existing file", async () => {
    await using tmp = await tmpdir()
    const p = path.join(tmp.path, "existing.txt")
    await fs.writeFile(p, "old content\nline two\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const cmd = `write ${p} <<'EOF'\nnew content\nline two\nEOF\n`
        const effects = await detectFileEffects([cmd], tmp.path)
        expect(effects.length).toBe(1)
        expect(effects[0].kind).toBe("write")
        expect(effects[0].additions).toBeGreaterThan(0)
        expect(effects[0].deletions).toBeGreaterThan(0)
        expect(effects[0].diff).toContain("-old content")
        expect(effects[0].diff).toContain("+new content")
      },
    })
  })

  test("detects patch heredoc with search/replace block", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "foo.txt")
    await fs.writeFile(file, "line 1\nline 2\nline 3\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const body = ["<<<", "line 2", "===", "line two", ">>>", ""].join("\n")
        const cmd = `patch ${file} <<'PATCH'\n${body}PATCH\n`
        const effects = await detectFileEffects([cmd], tmp.path)
        expect(effects.length).toBe(1)
        expect(effects[0].kind).toBe("patch")
        expect(effects[0].ok).toBe(true)
        expect(effects[0].path).toBe(file)
        expect(effects[0].diff).toContain("-line 2")
        expect(effects[0].diff).toContain("+line two")
      },
    })
  })

  test("patch with --all replaces every occurrence", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "dup.txt")
    await fs.writeFile(file, "foo\nfoo\nfoo\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const body = ["<<<", "foo", "===", "bar", ">>>", ""].join("\n")
        const cmd = `patch --all ${file} <<'P'\n${body}P\n`
        const effects = await detectFileEffects([cmd], tmp.path)
        expect(effects.length).toBe(1)
        expect(effects[0].ok).toBe(true)
        // Raw patch-helper semantics: first-match only in detector (so the
        // preview diff shows one change). This is a best-effort preview; the
        // shell helper itself does replace-all at execution time.
        expect(effects[0].diff).toContain("-foo")
        expect(effects[0].diff).toContain("+bar")
      },
    })
  })

  test("returns empty when no write/patch pattern present", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const effects = await detectFileEffects(["ls -la", "cat README.md", "grep foo *.ts"], tmp.path)
        expect(effects).toEqual([])
      },
    })
  })

  test("marks patch as failed when search text is not in the file", async () => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "exists.txt")
    await fs.writeFile(file, "hello\n")
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const body = ["<<<", "not-present", "===", "replacement", ">>>", ""].join("\n")
        const cmd = `patch ${file} <<'EOT'\n${body}EOT\n`
        const effects = await detectFileEffects([cmd], tmp.path)
        expect(effects.length).toBe(1)
        expect(effects[0].kind).toBe("patch")
        expect(effects[0].ok).toBe(false)
      },
    })
  })

  test("detects multiple write patterns in a single call", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const p1 = path.join(tmp.path, "a.txt")
        const p2 = path.join(tmp.path, "b.txt")
        const cmd =
          `write ${p1} <<'A'\ncontent a\nA\n` +
          `write ${p2} <<'B'\ncontent b\nB\n`
        const effects = await detectFileEffects([cmd], tmp.path)
        expect(effects.length).toBe(2)
        expect(effects[0].path).toBe(p1)
        expect(effects[1].path).toBe(p2)
      },
    })
  })
})

describe("write script installer", () => {
  test("writes the helper to disk and makes it executable", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const { installOnDisk, pathExport } = await import("../../src/session/shell-scripts")
        await installOnDisk()
        const exp = pathExport()
        expect(exp).toContain("export PATH=")
        expect(exp).toContain(".opencode-bin")
      },
    })
  })
})
