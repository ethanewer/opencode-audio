import { describe, expect, test } from "bun:test"

/**
 * Pure predicate tests for the DialogWorktree component logic.
 * Tests option generation and last-session lookup without Solid reactivity.
 */

type Session = {
  workspaceID?: string
  parentID?: string
  title?: string
  time: { updated: number }
}

type Workspace = {
  id: string
  name?: string
  type: string
}

function last(sessions: Session[], id: string) {
  const match = sessions
    .filter((s) => s.workspaceID === id && !s.parentID)
    .sort((a, b) => b.time.updated - a.time.updated)[0]
  return match?.title
}

function options(workspaces: Workspace[], sessions: Session[], creating: boolean) {
  if (creating) return [{ title: "Creating worktree...", value: "__creating__", description: "" }]
  return [
    ...workspaces
      .filter((w) => w.type === "worktree")
      .map((w) => {
        const title = last(sessions, w.id)
        return {
          title: w.name ?? w.id,
          value: w.id,
          description: title ?? "no sessions",
        }
      }),
    { title: "+ New worktree", value: "__new__", description: "Create a new git worktree" },
  ]
}

describe("DialogWorktree options", () => {
  test("shows only + New worktree when no workspaces exist", () => {
    const result = options([], [], false)
    expect(result).toHaveLength(1)
    expect(result[0].value).toBe("__new__")
  })

  test("filters to only worktree type workspaces", () => {
    const workspaces: Workspace[] = [
      { id: "ws-1", name: "local-ws", type: "local" },
      { id: "ws-2", name: "wt-1", type: "worktree" },
    ]
    const result = options(workspaces, [], false)
    expect(result).toHaveLength(2)
    expect(result[0].title).toBe("wt-1")
    expect(result[0].value).toBe("ws-2")
    expect(result[1].value).toBe("__new__")
  })

  test("shows workspace name, falls back to id", () => {
    const workspaces: Workspace[] = [
      { id: "ws-1", name: "named", type: "worktree" },
      { id: "ws-2", type: "worktree" },
    ]
    const result = options(workspaces, [], false)
    expect(result[0].title).toBe("named")
    expect(result[1].title).toBe("ws-2")
  })

  test("shows last session title as description", () => {
    const workspaces: Workspace[] = [{ id: "ws-1", name: "wt", type: "worktree" }]
    const sessions: Session[] = [
      { workspaceID: "ws-1", title: "old task", time: { updated: 100 } },
      { workspaceID: "ws-1", title: "recent task", time: { updated: 200 } },
    ]
    const result = options(workspaces, sessions, false)
    expect(result[0].description).toBe("recent task")
  })

  test("shows 'no sessions' when workspace has no sessions", () => {
    const workspaces: Workspace[] = [{ id: "ws-1", name: "wt", type: "worktree" }]
    const result = options(workspaces, [], false)
    expect(result[0].description).toBe("no sessions")
  })

  test("excludes child sessions (parentID set)", () => {
    const workspaces: Workspace[] = [{ id: "ws-1", name: "wt", type: "worktree" }]
    const sessions: Session[] = [
      { workspaceID: "ws-1", parentID: "parent-1", title: "child", time: { updated: 300 } },
      { workspaceID: "ws-1", title: "root session", time: { updated: 100 } },
    ]
    const result = options(workspaces, sessions, false)
    expect(result[0].description).toBe("root session")
  })

  test("ignores sessions from other workspaces", () => {
    const workspaces: Workspace[] = [{ id: "ws-1", name: "wt", type: "worktree" }]
    const sessions: Session[] = [
      { workspaceID: "ws-2", title: "other workspace", time: { updated: 500 } },
    ]
    const result = options(workspaces, sessions, false)
    expect(result[0].description).toBe("no sessions")
  })

  test("shows creating state", () => {
    const workspaces: Workspace[] = [{ id: "ws-1", name: "wt", type: "worktree" }]
    const result = options(workspaces, [], true)
    expect(result).toHaveLength(1)
    expect(result[0].value).toBe("__creating__")
    expect(result[0].title).toBe("Creating worktree...")
  })

  test("multiple worktrees with sessions sorted correctly", () => {
    const workspaces: Workspace[] = [
      { id: "ws-1", name: "alpha", type: "worktree" },
      { id: "ws-2", name: "beta", type: "worktree" },
    ]
    const sessions: Session[] = [
      { workspaceID: "ws-1", title: "alpha old", time: { updated: 10 } },
      { workspaceID: "ws-1", title: "alpha new", time: { updated: 50 } },
      { workspaceID: "ws-2", title: "beta only", time: { updated: 30 } },
    ]
    const result = options(workspaces, sessions, false)
    expect(result).toHaveLength(3)
    expect(result[0].description).toBe("alpha new")
    expect(result[1].description).toBe("beta only")
    expect(result[2].value).toBe("__new__")
  })
})

describe("DialogWorktree last()", () => {
  test("returns undefined for empty sessions", () => {
    expect(last([], "ws-1")).toBeUndefined()
  })

  test("returns most recently updated session title", () => {
    const sessions: Session[] = [
      { workspaceID: "ws-1", title: "old", time: { updated: 1 } },
      { workspaceID: "ws-1", title: "newest", time: { updated: 3 } },
      { workspaceID: "ws-1", title: "mid", time: { updated: 2 } },
    ]
    expect(last(sessions, "ws-1")).toBe("newest")
  })

  test("returns undefined for session with no title", () => {
    const sessions: Session[] = [{ workspaceID: "ws-1", time: { updated: 1 } }]
    expect(last(sessions, "ws-1")).toBeUndefined()
  })
})

describe("prompt /worktree intercept", () => {
  function parseSlash(input: string) {
    if (!input.startsWith("/")) return
    const end = input.indexOf("\n")
    const line = end === -1 ? input : input.slice(0, end)
    const [head, ...rest] = line.split(" ")
    return {
      name: head.slice(1),
      args: rest.join(" ") + (end === -1 ? "" : input.slice(end + 1) ? "\n" + input.slice(end + 1) : ""),
    }
  }

  type Action = "worktree" | "append" | "passthrough"

  function intercept(input: string): Action {
    const slash = parseSlash(input)
    if (slash?.name === "append") return "append"
    if (slash?.name === "worktree") return "worktree"
    return "passthrough"
  }

  test("/worktree triggers worktree command", () => {
    expect(intercept("/worktree")).toBe("worktree")
  })

  test("/worktree with trailing space", () => {
    expect(intercept("/worktree ")).toBe("worktree")
  })

  test("/append triggers append command", () => {
    expect(intercept("/append")).toBe("append")
  })

  test("regular text passes through", () => {
    expect(intercept("fix the bug")).toBe("passthrough")
  })

  test("empty string passes through", () => {
    expect(intercept("")).toBe("passthrough")
  })

  test("/new passes through (not intercepted)", () => {
    expect(intercept("/new")).toBe("passthrough")
  })

  test("/worktree with args still intercepts", () => {
    expect(intercept("/worktree my-feature")).toBe("worktree")
  })

  test("worktree without slash passes through", () => {
    expect(intercept("worktree")).toBe("passthrough")
  })
})

describe("DialogWorktree delete flow", () => {
  type Action = "ignore" | "arm" | "delete"

  function onDelete(value: string, deleting: string | undefined): { action: Action; deleting: string | undefined } {
    if (value === "__creating__" || value === "__new__") return { action: "ignore", deleting }
    if (deleting !== value) return { action: "arm", deleting: value }
    return { action: "delete", deleting: undefined }
  }

  test("ignores __creating__ option", () => {
    const result = onDelete("__creating__", undefined)
    expect(result.action).toBe("ignore")
  })

  test("ignores __new__ option", () => {
    const result = onDelete("__new__", undefined)
    expect(result.action).toBe("ignore")
  })

  test("first press arms the delete", () => {
    const result = onDelete("ws-1", undefined)
    expect(result.action).toBe("arm")
    expect(result.deleting).toBe("ws-1")
  })

  test("second press on same item confirms delete", () => {
    const result = onDelete("ws-1", "ws-1")
    expect(result.action).toBe("delete")
    expect(result.deleting).toBeUndefined()
  })

  test("pressing on different item re-arms", () => {
    const result = onDelete("ws-2", "ws-1")
    expect(result.action).toBe("arm")
    expect(result.deleting).toBe("ws-2")
  })

  test("full cycle: arm then confirm", () => {
    const r1 = onDelete("ws-1", undefined)
    expect(r1.action).toBe("arm")
    const r2 = onDelete("ws-1", r1.deleting)
    expect(r2.action).toBe("delete")
    expect(r2.deleting).toBeUndefined()
  })

  test("moving to a different option resets armed state", () => {
    const armed = onDelete("ws-1", undefined)
    expect(armed.deleting).toBe("ws-1")
    // onMove clears deleting
    const afterMove: string | undefined = undefined
    const r2 = onDelete("ws-1", afterMove)
    expect(r2.action).toBe("arm")
  })
})

describe("DialogWorktree onSelect routing", () => {
  test("__creating__ value is a no-op", () => {
    let called = false
    const handler = (value: string) => {
      if (value === "__creating__") return
      called = true
    }
    handler("__creating__")
    expect(called).toBe(false)
  })

  test("__new__ triggers create flow", () => {
    let created = false
    const handler = (value: string) => {
      if (value === "__new__") {
        created = true
        return
      }
    }
    handler("__new__")
    expect(created).toBe(true)
  })

  test("workspace id triggers select flow", () => {
    let selected: string | undefined
    const handler = (value: string) => {
      if (value === "__creating__" || value === "__new__") return
      selected = value
    }
    handler("ws-123")
    expect(selected).toBe("ws-123")
  })
})
