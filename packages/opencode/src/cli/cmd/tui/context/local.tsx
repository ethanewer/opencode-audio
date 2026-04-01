import { createStore } from "solid-js/store"
import { batch, createEffect, createMemo } from "solid-js"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { uniqueBy } from "remeda"
import path from "path"
import { Global } from "@/global"
import { iife } from "@/util/iife"
import { createSimpleContext } from "./helper"
import { useToast } from "../ui/toast"
import { Provider } from "@/provider/provider"
import { useArgs } from "./args"
import { useSDK } from "./sdk"
import { RGBA } from "@opentui/core"
import { Filesystem } from "@/util/filesystem"

type SystemDef = {
  label?: string
  model: string
  variant?: string
  transcription?: string
  tts?: {
    model?: string
    voice?: string
    speed?: number
    status?: boolean
  }
  agents: string[]
  options?: Record<string, unknown>
}
type SystemEntry = SystemDef & { key: string }

const DEFAULT_SYSTEMS: SystemEntry[] = [
  {
    key: "claude-opus-medium-voice",
    label: "Claude Opus 4.6",
    model: "anthropic/claude-opus-4-6",
    variant: "medium",
    transcription: "gpt-4o-mini-transcribe",
    tts: { model: "gpt-4o-mini-tts", voice: "echo", speed: 1.25 },
    agents: ["build", "plan"],
  },
  {
    key: "claude-opus-high",
    label: "Claude Opus 4.6",
    model: "anthropic/claude-opus-4-6",
    variant: "high",
    transcription: "gpt-4o-mini-transcribe",
    agents: ["build", "plan"],
  },
  {
    key: "claude-opus-max",
    label: "Claude Opus 4.6",
    model: "anthropic/claude-opus-4-6",
    variant: "max",
    transcription: "gpt-4o-mini-transcribe",
    agents: ["build", "plan"],
  },
  {
    key: "gpt-medium",
    label: "GPT 5.4",
    model: "openai/gpt-5.4",
    variant: "medium",
    transcription: "gpt-4o-mini-transcribe",
    agents: ["build", "plan"],
  },
  {
    key: "gpt-high",
    label: "GPT 5.4",
    model: "openai/gpt-5.4",
    variant: "high",
    transcription: "gpt-4o-mini-transcribe",
    agents: ["build", "plan"],
  },
  {
    key: "gpt-xhigh",
    label: "GPT 5.4",
    model: "openai/gpt-5.4",
    variant: "xhigh",
    transcription: "gpt-4o-mini-transcribe",
    agents: ["build", "plan"],
  },
  {
    key: "gpt-audio",
    label: "GPT Audio",
    model: "openai/gpt-audio",
    agents: ["build", "plan"],
  },
  {
    key: "gemini-flash",
    label: "Gemini 3.1 Flash Lite",
    model: "openrouter/google/gemini-3.1-flash-lite-preview",
    agents: ["build", "plan"],
  },
  {
    key: "gemini-pro",
    label: "Gemini 3.1 Pro",
    model: "openrouter/google/gemini-3.1-pro-preview-customtools",
    agents: ["build", "plan"],
  },
]

export const { use: useLocal, provider: LocalProvider } = createSimpleContext({
  name: "Local",
  init: () => {
    const sync = useSync()
    const sdk = useSDK()
    const toast = useToast()

    function isModelValid(model: { providerID: string; modelID: string }) {
      const provider = sync.data.provider.find((x) => x.id === model.providerID)
      return !!provider?.models[model.modelID]
    }

    // ── System ────────────────────────────────────────────────────────
    const system = iife(() => {
      const systems = createMemo((): SystemEntry[] => {
        const cfg = sync.data.config as typeof sync.data.config & {
          system?: Record<string, SystemDef>
        }
        if (cfg.system && Object.keys(cfg.system).length > 0) {
          return Object.entries(cfg.system).map(([key, val]) => ({
            ...val,
            agents: val.agents ?? ["build", "plan"],
            key,
          }))
        }
        // Fallback: synthesize a single system from legacy model + voice config
        const model = cfg.model
        if (model) {
          const voice = cfg.experimental?.voice
          const tts = voice?.tts
          return [
            {
              key: "default",
              label: undefined,
              model,
              variant: undefined,
              transcription: voice?.model,
              tts: tts
                ? {
                    model: tts.model,
                    voice: tts.voice,
                    speed: tts.speed,
                    status: tts.status,
                  }
                : undefined,
              agents: ["build", "plan"],
              options: undefined,
            },
          ]
        }
        // Default systems for new installs
        return DEFAULT_SYSTEMS
      })

      const [store, setStore] = createStore<{ current: string; ready: boolean }>({
        current: "",
        ready: false,
      })

      // Load persisted system from disk
      const filePath = path.join(Global.Path.state, "system.json")
      Filesystem.readJson(filePath)
        .then((x: any) => {
          if (typeof x.current === "string") setStore("current", x.current)
        })
        .catch(() => {})
        .finally(() => setStore("ready", true))

      function save() {
        Filesystem.writeJson(filePath, { current: store.current })
      }

      // Ensure current is valid whenever systems change — wait for persisted value to load first
      createEffect(() => {
        if (!store.ready) return
        const list = systems()
        if (!list.length) return
        if (list.some((s) => s.key === store.current)) return
        setStore("current", list[0].key)
      })

      function info(entry: SystemEntry) {
        const parsed = Provider.parseModel(entry.model)
        const provider = sync.data.provider.find((x) => x.id === parsed.providerID)
        const model = provider?.models[parsed.modelID]
        const hasAudioOutput = model?.capabilities?.output?.audio ?? false
        const hasAudioInput = model?.capabilities?.input?.audio ?? false
        const hasTts = !!entry.tts
        const hasVoice = hasTts || hasAudioOutput
        return {
          ...entry,
          parsed,
          provider,
          model,
          hasAudioOutput,
          hasAudioInput,
          hasTts,
          hasVoice,
        }
      }

      return {
        list() {
          return systems()
        },
        current() {
          const list = systems()
          return list.find((s) => s.key === store.current) ?? list[0]
        },
        info() {
          return info(this.current())
        },
        infoFor(entry: SystemEntry) {
          return info(entry)
        },
        set(key: string) {
          if (!systems().some((s) => s.key === key)) {
            toast.show({ variant: "warning", message: `System not found: ${key}`, duration: 3000 })
            return
          }
          setStore("current", key)
          save()
        },
        move(direction: 1 | -1) {
          const list = systems()
          if (list.length <= 1) return
          let idx = list.findIndex((s) => s.key === store.current) + direction
          if (idx < 0) idx = list.length - 1
          if (idx >= list.length) idx = 0
          setStore("current", list[idx].key)
          save()
        },
      }
    })

    // ── Agent ─────────────────────────────────────────────────────────
    const agent = iife(() => {
      // Visible non-subagent agents scoped to the current system
      const agents = createMemo(() => {
        const cur = system.current()
        if (!cur) return sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden)
        const allowed = new Set(cur.agents)
        return sync.data.agent.filter((x) => x.mode !== "subagent" && !x.hidden && allowed.has(x.name))
      })
      const visibleAgents = createMemo(() => sync.data.agent.filter((x) => !x.hidden))
      const [agentStore, setAgentStore] = createStore<{ current: string }>({
        current: "build",
      })
      const { theme } = useTheme()
      const colors = createMemo(() => [
        theme.secondary,
        theme.accent,
        theme.success,
        theme.warning,
        theme.primary,
        theme.error,
        theme.info,
      ])

      // Ensure the current agent is valid for the current system
      createEffect(() => {
        const list = agents()
        if (!list.length) return
        if (list.some((x) => x.name === agentStore.current)) return
        // Try to preserve the base agent name across system switches
        const base = agentStore.current.replace(/^voice-/, "")
        const match = list.find((x) => x.name === base || x.name === `voice-${base}`)
        setAgentStore("current", match?.name ?? list[0].name)
      })

      return {
        list() {
          return agents()
        },
        current() {
          return agents().find((x) => x.name === agentStore.current) ?? agents()[0]
        },
        /** Returns the agent name to send to the backend — resolves voice agent mapping */
        resolved() {
          const cur = this.current()
          if (!cur) return "build"
          // Only resolve to voice agents when voice is enabled in config
          if (!sync.data.config.experimental?.voice?.enabled) return cur.name
          const sysInfo = system.info()
          // If system has voice and user-facing agent is build/plan, use voice variant
          if (sysInfo.hasVoice) {
            const voiceName = `voice-${cur.name}`
            if (sync.data.agent.some((a) => a.name === voiceName)) return voiceName
          }
          return cur.name
        },
        set(name: string) {
          if (!agents().some((x) => x.name === name))
            return toast.show({
              variant: "warning",
              message: `Agent not found: ${name}`,
              duration: 3000,
            })
          setAgentStore("current", name)
        },
        move(direction: 1 | -1) {
          batch(() => {
            let next = agents().findIndex((x) => x.name === agentStore.current) + direction
            if (next < 0) next = agents().length - 1
            if (next >= agents().length) next = 0
            const value = agents()[next]
            setAgentStore("current", value.name)
          })
        },
        color(name: string) {
          const index = visibleAgents().findIndex((x) => x.name === name)
          if (index === -1) return colors()[0]
          const a = visibleAgents()[index]

          if (a?.color) {
            const color = a.color
            if (color.startsWith("#")) return RGBA.fromHex(color)
            return theme[color as keyof typeof theme] as RGBA
          }
          return colors()[index % colors().length]
        },
      }
    })

    // ── Model ─────────────────────────────────────────────────────────
    const model = iife(() => {
      const [modelStore, setModelStore] = createStore<{
        ready: boolean
        recent: { providerID: string; modelID: string }[]
        favorite: { providerID: string; modelID: string }[]
        variant: Record<string, string | undefined>
      }>({
        ready: false,
        recent: [],
        favorite: [],
        variant: {},
      })

      const filePath = path.join(Global.Path.state, "model.json")
      const state = { pending: false }

      function save() {
        if (!modelStore.ready) {
          state.pending = true
          return
        }
        state.pending = false
        Filesystem.writeJson(filePath, {
          recent: modelStore.recent,
          favorite: modelStore.favorite,
          variant: modelStore.variant,
        })
      }

      Filesystem.readJson(filePath)
        .then((x: any) => {
          if (Array.isArray(x.recent)) setModelStore("recent", x.recent)
          if (Array.isArray(x.favorite)) setModelStore("favorite", x.favorite)
          if (typeof x.variant === "object" && x.variant !== null) setModelStore("variant", x.variant)
        })
        .catch(() => {})
        .finally(() => {
          setModelStore("ready", true)
          if (state.pending) save()
        })

      const args = useArgs()

      // Model is derived from the current system
      const currentModel = createMemo(() => {
        // CLI --model flag takes highest priority
        if (args.model) {
          const parsed = Provider.parseModel(args.model)
          if (isModelValid(parsed)) return parsed
        }

        // System model
        const cur = system.current()
        if (cur) {
          const parsed = Provider.parseModel(cur.model)
          if (isModelValid(parsed)) return parsed
        }

        // Fallback to config model
        if (sync.data.config.model) {
          const parsed = Provider.parseModel(sync.data.config.model)
          if (isModelValid(parsed)) return parsed
        }

        // Fallback to first provider default
        const provider = sync.data.provider[0]
        if (!provider) return undefined
        const def = sync.data.provider_default[provider.id]
        const first = Object.values(provider.models)[0]
        const mid = def ?? first?.id
        if (!mid) return undefined
        return { providerID: provider.id, modelID: mid }
      })

      return {
        current: currentModel,
        get ready() {
          return modelStore.ready
        },
        recent() {
          return modelStore.recent
        },
        favorite() {
          return modelStore.favorite
        },
        parsed: createMemo(() => {
          const value = currentModel()
          if (!value) {
            return {
              provider: "Connect a provider",
              model: "No provider selected",
              reasoning: false,
              audioInput: false,
              audioOutput: false,
            }
          }
          const provider = sync.data.provider.find((x) => x.id === value.providerID)
          const info = provider?.models[value.modelID]
          return {
            provider: provider?.name ?? value.providerID,
            model: info?.name ?? value.modelID,
            reasoning: info?.capabilities?.reasoning ?? false,
            audioInput: info?.capabilities?.input?.audio ?? false,
            audioOutput: info?.capabilities?.output?.audio ?? false,
          }
        }),
        set(m: { providerID: string; modelID: string }, options?: { recent?: boolean }) {
          batch(() => {
            if (!isModelValid(m)) {
              toast.show({
                message: `Model ${m.providerID}/${m.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            if (options?.recent) {
              const uniq = uniqueBy([m, ...modelStore.recent], (x) => `${x.providerID}/${x.modelID}`)
              if (uniq.length > 10) uniq.pop()
              setModelStore(
                "recent",
                uniq.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
              )
              save()
            }
          })
        },
        toggleFavorite(m: { providerID: string; modelID: string }) {
          batch(() => {
            if (!isModelValid(m)) {
              toast.show({
                message: `Model ${m.providerID}/${m.modelID} is not valid`,
                variant: "warning",
                duration: 3000,
              })
              return
            }
            const exists = modelStore.favorite.some((x) => x.providerID === m.providerID && x.modelID === m.modelID)
            const next = exists
              ? modelStore.favorite.filter((x) => x.providerID !== m.providerID || x.modelID !== m.modelID)
              : [m, ...modelStore.favorite]
            setModelStore(
              "favorite",
              next.map((x) => ({ providerID: x.providerID, modelID: x.modelID })),
            )
            save()
          })
        },
        variant: {
          current() {
            // System variant takes priority
            const cur = system.current()
            if (cur?.variant) return cur.variant
            const m = currentModel()
            if (!m) return undefined
            const key = `${m.providerID}/${m.modelID}`
            const v = modelStore.variant[key]
            if (!v) return undefined
            if (!this.list().includes(v)) return undefined
            return v
          },
          list() {
            const m = currentModel()
            if (!m) return []
            const provider = sync.data.provider.find((x) => x.id === m.providerID)
            const info = provider?.models[m.modelID]
            if (!info?.variants) return []
            return Object.keys(info.variants)
          },
          set(value: string | undefined) {
            const m = currentModel()
            if (!m) return
            const key = `${m.providerID}/${m.modelID}`
            setModelStore("variant", key, value ?? "default")
            save()
          },
          cycle() {
            const variants = this.list()
            if (variants.length === 0) return
            const current = this.current()
            if (!current) {
              this.set(variants[0])
              return
            }
            const index = variants.indexOf(current)
            if (index === -1 || index === variants.length - 1) {
              this.set(undefined)
              return
            }
            this.set(variants[index + 1])
          },
        },
      }
    })

    const mcp = {
      isEnabled(name: string) {
        const status = sync.data.mcp[name]
        return status?.status === "connected"
      },
      async toggle(name: string) {
        const status = sync.data.mcp[name]
        if (status?.status === "connected") {
          await sdk.client.mcp.disconnect({ name })
        } else {
          await sdk.client.mcp.connect({ name })
        }
      },
    }

    const result = {
      model,
      agent,
      system,
      mcp,
    }
    return result
  },
})
