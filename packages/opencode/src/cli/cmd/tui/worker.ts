import { Installation } from "@/installation"
import { Server } from "@/server/server"
import { Log } from "@/util/log"
import { Instance } from "@/project/instance"
import { InstanceBootstrap } from "@/project/bootstrap"
import { Rpc } from "@/util/rpc"
import { upgrade } from "@/cli/upgrade"
import { Config } from "@/config/config"
import { Bus } from "@/bus"
import { GlobalBus } from "@/bus/global"
import type { Event } from "@opencode-ai/sdk/v2"
import { Flag } from "@/flag/flag"
import { setTimeout as sleep } from "node:timers/promises"
import { writeHeapSnapshot } from "node:v8"
import { WorkspaceID } from "@/control-plane/schema"
import { Workspace } from "@/control-plane/workspace"
import { classify as classifyAudio, classifyMulti as classifyAudioMulti } from "@/audio/classify"
import { transcribe as transcribeBytes } from "@/audio/transcribe"
import { Provider } from "@/provider/provider"
import { ProviderID, ModelID } from "@/provider/schema"

await Log.init({
  print: process.argv.includes("--print-logs"),
  dev: Installation.isLocal(),
  level: (() => {
    if (Installation.isLocal()) return "DEBUG"
    return "INFO"
  })(),
})

process.on("unhandledRejection", (e) => {
  Log.Default.error("rejection", {
    e: e instanceof Error ? e.message : e,
  })
})

process.on("uncaughtException", (e) => {
  Log.Default.error("exception", {
    e: e instanceof Error ? e.message : e,
  })
})

// Subscribe to global events and forward them via RPC
GlobalBus.on("event", (event) => {
  Rpc.emit("global.event", event)
})

let server: Awaited<ReturnType<typeof Server.listen>> | undefined

const eventStream = {
  abort: undefined as AbortController | undefined,
}

const startEventStream = (input: { directory: string; workspaceID?: string }) => {
  if (eventStream.abort) eventStream.abort.abort()
  const abort = new AbortController()
  eventStream.abort = abort
  const signal = abort.signal

  // Subscribe to GlobalBus so we receive events from ALL instances
  // (main project + worktrees). This is critical for plan→build handoff
  // where the build session runs in a worktree Instance.
  function handler(event: { directory?: string; payload: unknown }) {
    Rpc.emit("event", event.payload as Event)
  }
  GlobalBus.on("event", handler)
  ;(async () => {
    // Bootstrap loop: keeps the primary Instance alive and re-bootstraps
    // after disposal (e.g. config update triggers Instance.dispose).
    while (!signal.aborted) {
      const shouldReconnect = await Instance.provide({
        directory: input.directory,
        init: InstanceBootstrap,
        fn: () =>
          new Promise<boolean>((resolve) => {
            Rpc.emit("event", {
              type: "server.connected",
              properties: {},
            } satisfies Event)

            let settled = false
            const settle = (value: boolean) => {
              if (settled) return
              settled = true
              signal.removeEventListener("abort", onAbort)
              unsub()
              resolve(value)
            }

            // Detect disposal of THIS instance via the per-instance bus.
            const unsub = Bus.subscribeAll((event) => {
              if (event.type === Bus.InstanceDisposed.type) {
                settle(true)
              }
            })

            const onAbort = () => settle(false)
            signal.addEventListener("abort", onAbort, { once: true })
          }),
      }).catch((error) => {
        Log.Default.error("instance bootstrap error", {
          error: error instanceof Error ? error.message : error,
        })
        return false
      })

      if (!shouldReconnect || signal.aborted) break
      if (!signal.aborted) await sleep(250)
    }

    GlobalBus.off("event", handler)
  })().catch((error) => {
    Log.Default.error("event stream error", {
      error: error instanceof Error ? error.message : error,
    })
  })
}

startEventStream({ directory: process.cwd() })

export const rpc = {
  async fetch(input: { url: string; method: string; headers: Record<string, string>; body?: string }) {
    const headers = { ...input.headers }
    const auth = getAuthorizationHeader()
    if (auth && !headers["authorization"] && !headers["Authorization"]) {
      headers["Authorization"] = auth
    }
    const request = new Request(input.url, {
      method: input.method,
      headers,
      body: input.body,
    })
    const response = await Server.Default().fetch(request)
    const body = await response.text()
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    }
  },
  snapshot() {
    const result = writeHeapSnapshot("server.heapsnapshot")
    return result
  },
  async server(input: { port: number; hostname: string; mdns?: boolean; cors?: string[] }) {
    if (server) await server.stop(true)
    server = await Server.listen(input)
    return { url: server.url.toString() }
  },
  async checkUpgrade(input: { directory: string }) {
    await Instance.provide({
      directory: input.directory,
      init: InstanceBootstrap,
      fn: async () => {
        await upgrade().catch(() => {})
      },
    })
  },
  async reload() {
    await Config.invalidate(true)
  },
  async setWorkspace(input: { workspaceID?: string }) {
    let dir = process.cwd()
    if (input.workspaceID) {
      const ws = await Instance.provide({
        directory: process.cwd(),
        init: InstanceBootstrap,
        fn: () => Workspace.get(WorkspaceID.make(input.workspaceID!)),
      })
      if (ws?.directory) dir = ws.directory
    }
    startEventStream({ directory: dir })
    return { directory: dir }
  },
  async classify(input: {
    providerID: string
    modelID: string
    transcript: string
    options: string[]
    question?: string
  }) {
    return Instance.provide({
      directory: process.cwd(),
      init: InstanceBootstrap,
      async fn() {
        const model = await Provider.getModel(ProviderID.make(input.providerID), ModelID.make(input.modelID))
        const lang = await Provider.getLanguage(model)
        return classifyAudio(lang, input.transcript, input.options, input.question)
      },
    })
  },
  async classifyMulti(input: {
    providerID: string
    modelID: string
    transcript: string
    options: string[]
    question?: string
  }) {
    return Instance.provide({
      directory: process.cwd(),
      init: InstanceBootstrap,
      async fn() {
        const model = await Provider.getModel(ProviderID.make(input.providerID), ModelID.make(input.modelID))
        const lang = await Provider.getLanguage(model)
        return classifyAudioMulti(lang, input.transcript, input.options, input.question)
      },
    })
  },
  async transcribe(input: { audio: string; model?: string }) {
    const bytes = new Uint8Array(Buffer.from(input.audio, "base64"))
    return transcribeBytes(bytes, input.model)
  },
  async speak(input: { text: string; model?: string; voice?: string }) {
    const { speak } = await import("@/audio/speak")
    const audio = await speak(input.text, { model: input.model, voice: input.voice })
    return Buffer.from(audio).toString("base64")
  },
  async shutdown() {
    Log.Default.info("worker shutting down")
    if (eventStream.abort) eventStream.abort.abort()
    await Instance.disposeAll()
    if (server) await server.stop(true)
  },
}

Rpc.listen(rpc)

function getAuthorizationHeader(): string | undefined {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return `Basic ${btoa(`${username}:${password}`)}`
}
