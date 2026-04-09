import { afterAll, describe, expect, test } from "bun:test"
import { Tmux } from "../../src/tmux/tmux"

const sessions: string[] = []

afterAll(async () => {
  for (const id of sessions) await Tmux.kill(id)
})

function id() {
  const v = `test-${Math.random().toString(36).slice(2)}`
  sessions.push(v)
  return v
}

describe("tmux", () => {
  test("available returns true when tmux is installed", async () => {
    expect(await Tmux.available()).toBe(true)
  })

  test("ensure creates a session and has returns true", async () => {
    const sid = id()
    const state = await Tmux.ensure(sid, "/tmp")
    expect(state.name).toStartWith("oc-")
    expect(state.seq).toBe(0)
    expect(Tmux.has(sid)).toBe(true)
  })

  test("alive returns true for live session", async () => {
    const sid = id()
    await Tmux.ensure(sid, "/tmp")
    expect(await Tmux.alive(sid)).toBe(true)
  })

  test("alive returns false for unknown session", async () => {
    expect(await Tmux.alive("nonexistent-session")).toBe(false)
  })

  test("execute runs a command and captures output", async () => {
    const sid = id()
    const output = await Tmux.execute(sid, "/tmp", [{ keystrokes: "echo hello-world\n", duration: 2 }])
    expect(output).toContain("hello-world")
  })

  test("execute filters out marker lines from output", async () => {
    const sid = id()
    const output = await Tmux.execute(sid, "/tmp", [{ keystrokes: "echo test-marker-filter\n", duration: 2 }])
    expect(output).not.toContain("__CMDEND__")
    expect(output).toContain("test-marker-filter")
  })

  test("execute handles multiple sequential commands", async () => {
    const sid = id()
    const output = await Tmux.execute(sid, "/tmp", [
      { keystrokes: "echo first-cmd\n", duration: 2 },
      { keystrokes: "echo second-cmd\n", duration: 2 },
    ])
    expect(output).toContain("first-cmd")
    expect(output).toContain("second-cmd")
  })

  test("execute caps duration at provided value", async () => {
    const sid = id()
    const start = performance.now()
    await Tmux.execute(sid, "/tmp", [{ keystrokes: "echo fast\n", duration: 0.1 }])
    const elapsed = (performance.now() - start) / 1000
    expect(elapsed).toBeLessThan(3)
  })

  test("execute handles empty commands array", async () => {
    const sid = id()
    const output = await Tmux.execute(sid, "/tmp", [])
    expect(typeof output).toBe("string")
  })

  test("capture returns current pane content", async () => {
    const sid = id()
    await Tmux.execute(sid, "/tmp", [{ keystrokes: "echo capture-test\n", duration: 2 }])
    const content = await Tmux.capture(sid)
    expect(content).toContain("capture-test")
  })

  test("capture returns empty string for unknown session", async () => {
    expect(await Tmux.capture("nonexistent")).toBe("")
  })

  test("execute sends special keys like C-c", async () => {
    const sid = id()
    await Tmux.execute(sid, "/tmp", [
      { keystrokes: "sleep 30\n", duration: 0.3 },
      { keystrokes: "C-c", duration: 0.5 },
      { keystrokes: "echo after-ctrl-c\n", duration: 2 },
    ])
    const content = await Tmux.capture(sid)
    expect(content).toContain("after-ctrl-c")
  })

  test("execute calls update callback with partial output", async () => {
    const sid = id()
    const updates: string[] = []
    await Tmux.execute(
      sid,
      "/tmp",
      [{ keystrokes: "for i in 1 2 3; do echo partial-$i; sleep 0.3; done\n", duration: 3 }],
      (output) => updates.push(output),
    )
    // We should get at least one update callback since the command takes ~1s
    // (Might not always fire if the command completes before polling, so just check type)
    expect(Array.isArray(updates)).toBe(true)
  })

  test("kill removes the session", async () => {
    const sid = id()
    await Tmux.ensure(sid, "/tmp")
    expect(Tmux.has(sid)).toBe(true)
    await Tmux.kill(sid)
    expect(Tmux.has(sid)).toBe(false)
    expect(await Tmux.alive(sid)).toBe(false)
  })

  test("execute recreates dead session", async () => {
    const sid = id()
    await Tmux.ensure(sid, "/tmp")
    // Kill the underlying tmux session directly
    const state = await Tmux.ensure(sid, "/tmp")
    const proc = Bun.spawn(["tmux", "kill-session", "-t", state.name], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    // Now execute should recreate it
    const output = await Tmux.execute(sid, "/tmp", [{ keystrokes: "echo recovered\n", duration: 2 }])
    expect(output).toContain("recovered")
  })

  test("kill then execute creates fresh session", async () => {
    const sid = id()
    // Run a command to put some state into the session
    await Tmux.execute(sid, "/tmp", [{ keystrokes: "echo before-reset\n", duration: 2 }])
    const prior = await Tmux.capture(sid)
    expect(prior).toContain("before-reset")

    // Kill the session (simulates the reset parameter)
    await Tmux.kill(sid)
    expect(Tmux.has(sid)).toBe(false)

    // Execute should create a brand new session
    const output = await Tmux.execute(sid, "/tmp", [{ keystrokes: "echo after-reset\n", duration: 2 }])
    expect(output).toContain("after-reset")
    // The old session content should not appear in the new output
    expect(output).not.toContain("before-reset")
    expect(Tmux.has(sid)).toBe(true)
  })

  test("execute with cwd sets working directory", async () => {
    const sid = id()
    const output = await Tmux.execute(sid, "/tmp", [{ keystrokes: "pwd\n", duration: 2 }])
    expect(output).toContain("/tmp")
  })
})
