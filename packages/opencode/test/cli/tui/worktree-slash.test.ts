import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { Instance } from "../../../src/project/instance"
import { Server } from "../../../src/server/server"
import { Session } from "../../../src/session"
import { Log } from "../../../src/util/log"
import { resetDatabase } from "../../fixture/db"
import { tmpdir } from "../../fixture/fixture"

Log.init({ print: false })

afterEach(async () => {
  await resetDatabase()
})

function req(app: ReturnType<typeof Server.Default>, path: string, opts: RequestInit & { dir: string; ws?: string }) {
  const url = new URL(path, "http://localhost")
  url.searchParams.set("directory", opts.dir)
  if (opts.ws) url.searchParams.set("workspace", opts.ws)
  return app.request(url.toString(), {
    method: opts.method,
    headers: {
      "content-type": "application/json",
      ...((opts.headers ?? {}) as Record<string, string>),
    },
    body: opts.body,
  })
}

describe("/worktree slash command e2e", () => {
  test("workspace create returns worktree info for git project", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const res = await req(app, "/experimental/workspace", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({ type: "worktree", branch: null }),
      })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.type).toBe("worktree")
      expect(body.name).toBeTruthy()
      expect(body.directory).toBeTruthy()
      expect(body.id).toBeTruthy()

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { Worktree } = await import("../../../src/worktree")
          await Worktree.remove({ directory: body.directory })
        },
      })
    } finally {
      await Instance.disposeAll()
    }
  })

  test("workspace create fails for non-git project", async () => {
    await using tmp = await tmpdir()
    const app = Server.Default()

    try {
      const res = await req(app, "/experimental/workspace", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({ type: "worktree", branch: null }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.name).toContain("Worktree")
    } finally {
      await Instance.disposeAll()
    }
  })

  test("workspace list returns created worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const empty = await req(app, "/experimental/workspace", { dir: tmp.path, method: "GET" })
      expect(empty.status).toBe(200)
      expect(await empty.json()).toEqual([])

      const created = await req(app, "/experimental/workspace", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({ type: "worktree", branch: null }),
      })
      const ws = await created.json()

      const listed = await req(app, "/experimental/workspace", { dir: tmp.path, method: "GET" })
      expect(listed.status).toBe(200)
      const items = await listed.json()
      expect(items).toHaveLength(1)
      expect(items[0].id).toBe(ws.id)
      expect(items[0].type).toBe("worktree")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { Worktree } = await import("../../../src/worktree")
          await Worktree.remove({ directory: ws.directory })
        },
      })
    } finally {
      await Instance.disposeAll()
    }
  })

  test("multiple workspace creates yield distinct worktrees", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const a = await req(app, "/experimental/workspace", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({ type: "worktree", branch: null }),
      })
      const b = await req(app, "/experimental/workspace", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({ type: "worktree", branch: null }),
      })
      const wsA = await a.json()
      const wsB = await b.json()

      expect(wsA.id).not.toBe(wsB.id)
      expect(wsA.name).not.toBe(wsB.name)
      expect(wsA.directory).not.toBe(wsB.directory)

      const listed = await req(app, "/experimental/workspace", { dir: tmp.path, method: "GET" })
      const items = await listed.json()
      expect(items).toHaveLength(2)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { Worktree } = await import("../../../src/worktree")
          await Worktree.remove({ directory: wsA.directory })
          await Worktree.remove({ directory: wsB.directory })
        },
      })
    } finally {
      await Instance.disposeAll()
    }
  })

  test("session created via workspace routes to worktree directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const created = await req(app, "/experimental/workspace", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({ type: "worktree", branch: null }),
      })
      const ws = await created.json()

      const sessionRes = await req(app, "/session", {
        dir: tmp.path,
        ws: ws.id,
        method: "POST",
        body: JSON.stringify({ workspaceID: ws.id }),
      })
      expect(sessionRes.status).toBe(200)
      const session = await sessionRes.json()
      expect(session.workspaceID).toBe(ws.id)
      expect(await fs.realpath(session.directory)).toBe(await fs.realpath(ws.directory))

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { Worktree } = await import("../../../src/worktree")
          await Worktree.remove({ directory: ws.directory })
        },
      })
    } finally {
      await Instance.disposeAll()
    }
  })

  test("session without workspace uses main directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const res = await req(app, "/session", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(200)
      const session = await res.json()
      expect(session.workspaceID).toBeUndefined()
      expect(session.directory).toBe(tmp.path)
    } finally {
      await Instance.disposeAll()
    }
  })

  test("worktree directory exists on disk after workspace create", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const created = await req(app, "/experimental/workspace", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({ type: "worktree", branch: null }),
      })
      const ws = await created.json()

      const exists = await fs
        .stat(ws.directory)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { Worktree } = await import("../../../src/worktree")
          await Worktree.remove({ directory: ws.directory })
        },
      })
    } finally {
      await Instance.disposeAll()
    }
  })

  test("workspace delete removes from list", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const created = await req(app, "/experimental/workspace", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({ type: "worktree", branch: null }),
      })
      const ws = await created.json()

      // Clean up the actual git worktree before calling workspace delete,
      // because Workspace.remove fires adaptor.remove without awaiting it.
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { Worktree } = await import("../../../src/worktree")
          await Worktree.remove({ directory: ws.directory })
        },
      })

      const del = await req(app, `/experimental/workspace/${ws.id}`, {
        dir: tmp.path,
        method: "DELETE",
      })
      expect(del.status).toBe(200)

      const listed = await req(app, "/experimental/workspace", { dir: tmp.path, method: "GET" })
      expect(await listed.json()).toEqual([])
    } finally {
      await Instance.disposeAll()
    }
  })

  test("multiple sessions in same worktree share workspaceID", async () => {
    await using tmp = await tmpdir({ git: true })
    const app = Server.Default()

    try {
      const created = await req(app, "/experimental/workspace", {
        dir: tmp.path,
        method: "POST",
        body: JSON.stringify({ type: "worktree", branch: null }),
      })
      const ws = await created.json()

      const s1 = await req(app, "/session", {
        dir: tmp.path,
        ws: ws.id,
        method: "POST",
        body: JSON.stringify({ workspaceID: ws.id }),
      })
      const s2 = await req(app, "/session", {
        dir: tmp.path,
        ws: ws.id,
        method: "POST",
        body: JSON.stringify({ workspaceID: ws.id }),
      })

      const session1 = await s1.json()
      const session2 = await s2.json()

      expect(session1.workspaceID).toBe(ws.id)
      expect(session2.workspaceID).toBe(ws.id)
      expect(session1.id).not.toBe(session2.id)
      expect(await fs.realpath(session1.directory)).toBe(await fs.realpath(session2.directory))

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { Worktree } = await import("../../../src/worktree")
          await Worktree.remove({ directory: ws.directory })
        },
      })
    } finally {
      await Instance.disposeAll()
    }
  })
})
