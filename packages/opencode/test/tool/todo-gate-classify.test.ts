import { afterEach, describe, test, expect } from "bun:test"
import { Permission } from "../../src/permission"
import { TodoGate } from "../../src/session/todo-gate"
import { Todo } from "../../src/session/todo"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

describe("TodoGate.allow with permission ruleset", () => {
  test("disabled when todowrite permission is deny", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        Todo.reset(session.id)
        const deny = Permission.fromConfig({ todowrite: "deny" })
        const result = TodoGate.allow(session.id, deny)
        expect(result.ok).toBe(true)
      },
    })
  })

  test("active when todowrite is allowed and no todos exist", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        Todo.reset(session.id)
        const allow = Permission.fromConfig({ todowrite: "allow" })
        const result = TodoGate.allow(session.id, allow)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.reason).toContain("do not have a todo list")
        }
      },
    })
  })

  test("disabled when called without a ruleset (direct/programmatic caller)", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        Todo.reset(session.id)
        // No ruleset passed — test harness or plugin caller
        const result = TodoGate.allow(session.id)
        expect(result.ok).toBe(true)
      },
    })
  })

  test("blocks when todowrite allowed and no in_progress todo", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        Todo.reset(session.id)
        Todo.update({
          sessionID: session.id,
          todos: [{ content: "Plan", status: "pending", notes: "initial sketch of work" }],
        })
        const allow = Permission.fromConfig({ todowrite: "allow" })
        const result = TodoGate.allow(session.id, allow)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.reason).toContain("in_progress")
        }
      },
    })
  })

  test("blocks when in_progress todo has short notes", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        Todo.reset(session.id)
        Todo.update({
          sessionID: session.id,
          todos: [{ content: "Do X", status: "in_progress", notes: "TBD" }],
        })
        const allow = Permission.fromConfig({ todowrite: "allow" })
        const result = TodoGate.allow(session.id, allow)
        expect(result.ok).toBe(false)
        if (!result.ok) {
          expect(result.reason).toContain("too-short")
        }
      },
    })
  })

  test("allows when in_progress todo has proper notes", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        Todo.reset(session.id)
        Todo.update({
          sessionID: session.id,
          todos: [
            {
              content: "Do X",
              status: "in_progress",
              notes: "Will grep for foo then edit the matching files to fix the bug.",
            },
          ],
        })
        const allow = Permission.fromConfig({ todowrite: "allow" })
        const result = TodoGate.allow(session.id, allow)
        expect(result.ok).toBe(true)
      },
    })
  })
})

describe("TodoGate.classifyShell", () => {
  const cases: Array<[string, "read-only" | "side-effect"]> = [
    // basic read-only
    ["ls", "read-only"],
    ["ls -la", "read-only"],
    ["cat /app/file.txt", "read-only"],
    ["grep foo bar.txt", "read-only"],
    ["find /app -name '*.py'", "read-only"],
    ["file /app/a.out", "read-only"],
    ["readelf -h /app/a.out", "read-only"],
    ["xxd /app/a.out", "read-only"],
    ["od -A x /app/a.out", "read-only"],
    ["true", "read-only"],
    ["false", "read-only"],
    ["sleep 5", "read-only"],
    // git read-only subcommands
    ["git status", "read-only"],
    ["git log --oneline", "read-only"],
    ["git diff HEAD", "read-only"],
    // git side-effect subcommands
    ["git commit -m 'msg'", "side-effect"],
    ["git push", "side-effect"],
    ["git checkout main", "side-effect"],
    // side-effect
    ["rm /tmp/foo", "side-effect"],
    ["mkdir /tmp/x", "side-effect"],
    ["pip install chess", "side-effect"],
    ["python3 script.py", "side-effect"],
    ["node foo.js", "side-effect"],
    ["make", "side-effect"],
    ["apt-get install curl", "side-effect"],
    // redirections
    ["echo foo > out.txt", "side-effect"],
    ["ls >> log.txt", "side-effect"],
    // wrapped side-effect commands
    ["timeout 5 python3 foo.py", "side-effect"],
    ["xargs rm", "side-effect"],
  ]

  for (const [cmd, want] of cases) {
    test(`${cmd} -> ${want}`, () => {
      expect(TodoGate.classifyShell(cmd)).toBe(want)
    })
  }
})
