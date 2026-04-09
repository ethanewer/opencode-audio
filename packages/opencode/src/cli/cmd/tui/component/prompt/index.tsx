import { BoxRenderable, TextareaRenderable, MouseEvent, PasteEvent, decodePasteBytes, t, dim, fg } from "@opentui/core"
import {
  batch,
  createEffect,
  createMemo,
  type JSX,
  onMount,
  createSignal,
  onCleanup,
  on,
  Show,
  Switch,
  Match,
  For,
} from "solid-js"
import "opentui-spinner/solid"
import path from "path"
import { Filesystem } from "@/util/filesystem"
import { useLocal } from "@tui/context/local"
import { useTheme } from "@tui/context/theme"
import { EmptyBorder, SplitBorder } from "@tui/component/border"
import { useSDK } from "@tui/context/sdk"
import { useRoute } from "@tui/context/route"
import { useSync } from "@tui/context/sync"
import { MessageID, PartID } from "@/session/schema"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import { createStore, produce } from "solid-js/store"
import { useKeybind } from "@tui/context/keybind"
import { usePromptHistory, type PromptInfo } from "./history"
import { assign } from "./part"
import { usePromptStash } from "./stash"
import { DialogStash } from "../dialog-stash"
import { type AutocompleteRef, Autocomplete } from "./autocomplete"
import { useCommandDialog } from "../dialog-command"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { Editor } from "@tui/util/editor"
import { useExit } from "../../context/exit"
import { Clipboard } from "../../util/clipboard"
import type { AssistantMessage, FilePart } from "@opencode-ai/sdk/v2"
import { TuiEvent } from "../../event"
import { iife } from "@/util/iife"
import { Locale } from "@/util/locale"
import { formatDuration } from "@/util/format"
import { createColors, createFrames } from "../../ui/spinner.ts"
import { useDialog } from "@tui/ui/dialog"
import { DialogProvider as DialogProviderConnect } from "../dialog-provider"
import { DialogAlert } from "../../ui/dialog-alert"
import { useToast } from "../../ui/toast"
import { useKV } from "../../context/kv"
import { useTextareaKeybindings } from "../textarea-keybindings"
import { DialogSkill } from "../dialog-skill"
import { usePromptRef, type PromptMode } from "../../context/prompt"
import { useVoice } from "../../util/voice"
import { resolve as resolveAuto } from "./auto-restore"

export type PromptProps = {
  sessionID?: string
  workspaceID?: string
  visible?: boolean
  disabled?: boolean
  onSubmit?: () => void
  ref?: (ref: PromptRef) => void
  hint?: JSX.Element
  showPlaceholder?: boolean
  speaking?: () => boolean
  cancelSpeech?: () => void
  shouldDefer?: () => boolean
  onDefer?: (draft: DeferredDraft) => void
  deferred?: () => DeferredDraft[]
  appendMode?: () => boolean
  placeholders?: {
    normal?: string[]
    shell?: string[]
  }
}

export type DeferredDraft = {
  id: string
  sessionID?: string
  input: string
  parts: PromptInfo["parts"]
  type: "normal" | "shell" | "command"
  command?: string
  args?: string
  model: { providerID: string; modelID: string }
  agent: string
  variant?: string
  vision?: string
}

export type PromptRef = {
  focused: boolean
  current: PromptInfo
  set(prompt: PromptInfo): void
  reset(): void
  blur(): void
  focus(): void
  submit(): void
}

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

function autoTools(local: ReturnType<typeof useLocal>) {
  return Object.fromEntries(local.agent.auto.rules("plan").map((item) => [item.permission, false]))
}

export async function dispatchDraft(opts: {
  sdk: ReturnType<typeof useSDK>
  local: ReturnType<typeof useLocal>
  draft: DeferredDraft & { sessionID: string }
}) {
  if (opts.draft.agent === "auto" && opts.local.agent.current()?.name !== "auto") {
    opts.local.agent.set("auto")
  }
  if (opts.draft.agent === "auto") {
    await Session.setPermission({
      sessionID: SessionID.make(opts.draft.sessionID),
      permission: opts.local.agent.auto.rules("plan"),
    })
  }
  const agent = opts.local.agent.resolve(opts.draft.agent)
  const draft = opts.draft
  if (draft.type === "shell") {
    const result = opts.sdk.client.session.shell({
      sessionID: draft.sessionID,
      agent,
      model: draft.model,
      command: draft.input,
    })
    if (draft.agent === "auto") opts.local.agent.auto.start()
    return result
  }
  if (draft.type === "command") {
    const result = opts.sdk.client.session.command({
      sessionID: draft.sessionID,
      command: draft.command!,
      arguments: draft.args ?? "",
      agent,
      model: `${draft.model.providerID}/${draft.model.modelID}`,
      variant: draft.variant,
      parts: draft.parts
        .filter((x): x is FilePart => x.type === "file")
        .map(({ id: _, ...x }) => ({
          id: PartID.ascending(),
          ...x,
        })),
    })
    if (draft.agent === "auto") opts.local.agent.auto.start()
    return result
  }
  const result = opts.sdk.client.session.prompt({
    sessionID: draft.sessionID,
    ...draft.model,
    messageID: MessageID.ascending(),
    agent,
    model: draft.model,
    variant: draft.variant,
    vision: draft.vision,
    ...(draft.agent === "auto" ? { tools: autoTools(opts.local) } : {}),
    parts: [
      {
        id: PartID.ascending(),
        type: "text",
        text: draft.input,
      },
      ...draft.parts.map(assign),
    ],
  })
  if (draft.agent === "auto") opts.local.agent.auto.start()
  return result
}

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

const zed = process.env.TERM_PROGRAM?.toLowerCase() === "zed"

function randomIndex(count: number) {
  if (count <= 0) return 0
  return Math.floor(Math.random() * count)
}

export function Prompt(props: PromptProps) {
  let input: TextareaRenderable
  let anchor: BoxRenderable
  let autocomplete: AutocompleteRef

  const keybind = useKeybind()
  const local = useLocal()
  const sdk = useSDK()
  const route = useRoute()
  const sync = useSync()
  const dialog = useDialog()
  const toast = useToast()
  const status = createMemo(() => sync.data.session_status?.[props.sessionID ?? ""] ?? { type: "idle" })
  const session = createMemo(() => (props.sessionID ? sync.session.get(props.sessionID) : undefined))
  const messages = createMemo(() => (props.sessionID ? (sync.data.message[props.sessionID] ?? []) : []))
  const history = usePromptHistory()
  const stash = usePromptStash()
  const command = useCommandDialog()
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const kv = useKV()
  const [cols, setCols] = createSignal(0)
  const list = createMemo(() => props.placeholders?.normal ?? [])
  const shell = createMemo(() => props.placeholders?.shell ?? [])
  const deferred = createMemo(() => props.deferred?.() ?? [])

  function promptModelWarning() {
    toast.show({
      variant: "warning",
      message: "Connect a provider to send prompts",
      duration: 3000,
    })
    if (sync.data.provider.length === 0) {
      dialog.replace(() => <DialogProviderConnect />)
    }
  }

  const textareaKeybindings = useTextareaKeybindings()
  const promptRef = usePromptRef()

  const fileStyleId = syntax().getStyleId("extmark.file")!
  const agentStyleId = syntax().getStyleId("extmark.agent")!
  const pasteStyleId = syntax().getStyleId("extmark.paste")!
  let promptPartTypeId = 0

  sdk.event.on(TuiEvent.PromptAppend.type, (evt) => {
    if (!input || input.isDestroyed) return
    input.insertText(evt.properties.text)
    setTimeout(() => {
      // setTimeout is a workaround and needs to be addressed properly
      if (!input || input.isDestroyed) return
      input.getLayoutNode().markDirty()
      input.gotoBufferEnd()
      renderer.requestRender()
    }, 0)
  })

  createEffect(() => {
    if (props.disabled) input.cursorColor = theme.backgroundElement
    if (!props.disabled) input.cursorColor = theme.text
  })

  const lastUserMessage = createMemo(() => {
    return messages().findLast((m) => m.role === "user")
  })

  const parts = createMemo(() => {
    const msg = lastUserMessage()
    if (!msg) return []
    return sync.data.part[msg.id] ?? []
  })

  const usage = createMemo(() => {
    if (!props.sessionID) return
    const msg = sync.data.message[props.sessionID] ?? []
    const last = msg.findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    if (tokens <= 0) return

    const model = sync.data.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    const pct = model?.limit.context ? `${Math.round((tokens / model.limit.context) * 100)}%` : undefined
    const cost = msg.reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0)
    return {
      context: pct ? `${Locale.number(tokens)} (${pct})` : Locale.number(tokens),
      cost: cost > 0 ? money.format(cost) : undefined,
    }
  })

  const [store, setStore] = createStore<{
    prompt: PromptInfo
    mode: PromptMode
    extmarkToPartIndex: Map<number, number>
    interrupt: number
    placeholder: number
    returnToVoice: boolean
  }>({
    placeholder: randomIndex(list().length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: promptRef.mode,
    extmarkToPartIndex: new Map(),
    interrupt: 0,
    returnToVoice: false,
  })

  createEffect(() => promptRef.setMode(store.mode))

  let submitting = false

  function prepend(text: string) {
    const val = text.trim()
    if (!val) return
    const gap = input.plainText ? " " : ""
    input.cursorOffset = 0
    input.insertText(val + gap)
    const next = input.plainText
    setStore("prompt", "input", next)
    syncExtmarksWithPromptParts()
    input.cursorOffset = Bun.stringWidth(next)
  }

  const voice = useVoice({
    onResult(text) {
      if (store.mode !== "voice") {
        prepend(text)
        return
      }
      if (!text.trim()) return
      submitting = true
      input.setText(text)
      setStore("prompt", "input", text)
      submit().finally(() => {
        submitting = false
      })
    },
    onFinish(text) {
      if (store.mode === "voice") {
        batch(() => {
          setStore("returnToVoice", true)
          setStore("mode", "normal")
        })
      }
      prepend(text)
    },
    onFinishAudio(audio) {
      if (store.mode === "voice") {
        batch(() => {
          setStore("returnToVoice", true)
          setStore("mode", "normal")
        })
      }
      const url = `data:audio/wav;base64,${Buffer.from(audio).toString("base64")}`
      const currentOffset = input.visualCursor.offset
      const extmarkStart = currentOffset
      const count = store.prompt.parts.filter((x) => x.type === "file" && x.mime?.startsWith("audio/")).length
      const virtualText = `[Recording ${count + 1}]`
      const extmarkEnd = extmarkStart + virtualText.length
      input.insertText(virtualText + " ")

      const extmarkId = input.extmarks.create({
        start: extmarkStart,
        end: extmarkEnd,
        virtual: true,
        styleId: pasteStyleId,
        typeId: promptPartTypeId,
      })

      setStore(
        produce((draft) => {
          const partIndex = draft.prompt.parts.length
          draft.prompt.parts.push({
            type: "file" as const,
            mime: "audio/wav",
            url,
            filename: "recording.wav",
            source: {
              type: "file",
              path: "recording.wav",
              text: {
                start: extmarkStart,
                end: extmarkEnd,
                value: virtualText,
              },
            },
          })
          draft.extmarkToPartIndex.set(extmarkId, partIndex)
        }),
      )
    },
    audioInput: () => !!local.system.info().hasAudioInput,
    async onAudio(audio) {
      if (store.mode !== "voice") return
      const selected = local.model.current()
      if (!selected) return
      const url = `data:audio/wav;base64,${Buffer.from(audio).toString("base64")}`

      // Respect append/defer mode for audio input
      if (props.shouldDefer?.() && props.sessionID) {
        props.onDefer?.({
          id: MessageID.ascending(),
          sessionID: props.sessionID,
          input: "[voice audio input]",
          parts: [
            {
              type: "file" as const,
              mime: "audio/wav",
              url,
              filename: "recording.wav",
            },
          ],
          type: "normal",
          model: {
            providerID: selected.providerID,
            modelID: selected.modelID,
          },
          agent: local.agent.current()?.name ?? "build",
          variant: local.model.variant.current(),
          vision: local.system.current()?.vision,
        })
        return
      }

      let sessionID = props.sessionID
      if (sessionID == null) {
        const res = await sdk.client.session.create({
          workspaceID: props.workspaceID,
        })
        if (res.error) return
        sessionID = res.data.id
        if (local.agent.current()?.name === "auto") local.agent.auto.arm(sessionID)
      }
      if (local.agent.current()?.name === "auto") {
        await Session.setPermission({
          sessionID: SessionID.make(sessionID),
          permission: local.agent.auto.rules("plan"),
        })
      }
      sdk.client.session
        .prompt({
          sessionID,
          ...selected,
          messageID: MessageID.ascending(),
          agent: local.agent.resolved(),
          model: selected,
          variant: local.model.variant.current(),
          vision: local.system.current()?.vision,
          ...(local.agent.current()?.name === "auto" ? { tools: autoTools(local) } : {}),
          parts: [
            {
              id: PartID.ascending(),
              type: "file" as const,
              mime: "audio/wav",
              url,
              filename: "recording.wav",
            },
            {
              id: PartID.ascending(),
              type: "text" as const,
              text: "[voice audio input]",
            },
          ],
        })
        .catch(() => {})
      if (local.agent.current()?.name === "auto") {
        local.agent.auto.start()
      }
      props.onSubmit?.()
      if (!props.sessionID)
        setTimeout(() => {
          route.navigate({
            type: "session",
            sessionID,
          })
        }, 50)
    },
    color: theme.warning,
  })

  createEffect(
    on(
      () => store.mode,
      (mode) => {
        if (mode !== "voice" && !voice.busy()) voice.cancel()
      },
    ),
  )

  // If text appears in the prompt while in voice mode (e.g. from /skills or /undo),
  // switch to normal mode so the user can edit and submit it.
  // The submitting guard prevents this from firing during voice transcription submit.
  createEffect(
    on(
      () => store.prompt.input,
      (val) => {
        if (submitting) return
        if (store.mode === "voice" && val) {
          setStore("returnToVoice", true)
          setStore("mode", "normal")
        }
      },
      { defer: true },
    ),
  )

  createEffect(
    on(
      () => props.sessionID,
      () => {
        setStore("placeholder", randomIndex(list().length))
      },
      { defer: true },
    ),
  )

  // Initialize agent/model/variant from last user message when session changes
  let syncedSessionID: string | undefined
  createEffect(() => {
    const sessionID = props.sessionID
    const msg = lastUserMessage()

    if (sessionID !== syncedSessionID) {
      if (!sessionID || !msg) return
      // Defer until session_status has been bulk-loaded (sync "complete")
      // or an SSE event has already populated this session's status.
      if (sync.data.status !== "complete" && !sync.data.session_status?.[sessionID]) return

      syncedSessionID = sessionID

      // Try to restore agent and system from the current session state.
      if (msg.agent) {
        // Find a system matching the message's model AND variant
        if (msg.model) {
          const modelKey = `${msg.model.providerID}/${msg.model.modelID}`
          const candidates = local.system.list().filter((s) => s.model === modelKey)
          // Prefer exact model+variant match, fall back to model-only match
          const match = candidates.find((s) => s.variant === msg.variant) ?? candidates[0]
          if (match) local.system.set(match.key)
        }
        const next = resolveAuto({
          msg,
          parts: parts(),
          session: session(),
          status: status(),
        })
        if (next?.agent === "auto") {
          local.agent.set("auto")
          local.agent.auto.setPhase(next.phase ?? "idle")
        } else {
          const base = next?.agent ?? msg.agent.replace(/^voice-/, "")
          const keepAuto = local.agent.current()?.name === "auto" && local.agent.auto.claim(sessionID, base)
          const isPrimaryAgent = local.agent.list().some((x) => x.name === base || x.name === msg.agent)
          if (isPrimaryAgent && !keepAuto) local.agent.set(base)
        }
        if (msg.variant) local.model.variant.set(msg.variant)
      }
    }
  })

  command.register(() => {
    return [
      {
        title: "Clear prompt",
        value: "prompt.clear",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          input.extmarks.clear()
          input.clear()
          dialog.clear()
        },
      },
      {
        title: "Submit prompt",
        value: "prompt.submit",
        keybind: "input_submit",
        category: "Prompt",
        hidden: true,
        onSelect: (dialog) => {
          if (!input.focused) return
          submit()
          dialog.clear()
        },
      },
      {
        title: "Paste",
        value: "prompt.paste",
        keybind: "input_paste",
        category: "Prompt",
        hidden: true,
        onSelect: async () => {
          if (store.mode === "voice") {
            if (voice.recording()) voice.finish()
            setStore("mode", "normal")
          }
          const content = await Clipboard.read()
          if (content?.mime.startsWith("image/")) {
            await pasteImage({
              filename: "clipboard",
              mime: content.mime,
              content: content.data,
            })
          }
        },
      },
      {
        title: "Interrupt session",
        value: "session.interrupt",
        keybind: "session_interrupt",
        category: "Session",
        hidden: true,
        enabled: status().type !== "idle",
        onSelect: (dialog) => {
          if (autocomplete.visible) return
          if (!input.focused) return
          // TODO: this should be its own command
          if (store.mode === "shell") {
            if (store.returnToVoice) {
              setStore("returnToVoice", false)
              setStore("mode", "voice")
            } else {
              setStore("mode", "normal")
            }
            return
          }
          if (!props.sessionID) return

          setStore("interrupt", store.interrupt + 1)

          setTimeout(() => {
            setStore("interrupt", 0)
          }, 5000)

          if (store.interrupt >= 2) {
            sdk.client.session.abort({
              sessionID: props.sessionID,
            })
            setStore("interrupt", 0)
          }
          dialog.clear()
        },
      },
      {
        title: "Open editor",
        category: "Session",
        keybind: "editor_open",
        value: "prompt.editor",
        slash: {
          name: "editor",
        },
        onSelect: async (dialog) => {
          dialog.clear()

          // replace summarized text parts with the actual text
          const text = store.prompt.parts
            .filter((p) => p.type === "text")
            .reduce((acc, p) => {
              if (!p.source) return acc
              return acc.replace(p.source.text.value, p.text)
            }, store.prompt.input)

          const nonTextParts = store.prompt.parts.filter((p) => p.type !== "text")

          const value = text
          const content = await Editor.open({ value, renderer })
          if (!content) return

          input.setText(content)

          // Update positions for nonTextParts based on their location in new content
          // Filter out parts whose virtual text was deleted
          // this handles a case where the user edits the text in the editor
          // such that the virtual text moves around or is deleted
          const updatedNonTextParts = nonTextParts
            .map((part) => {
              let virtualText = ""
              if (part.type === "file" && part.source?.text) {
                virtualText = part.source.text.value
              } else if (part.type === "agent" && part.source) {
                virtualText = part.source.value
              }

              if (!virtualText) return part

              const newStart = content.indexOf(virtualText)
              // if the virtual text is deleted, remove the part
              if (newStart === -1) return null

              const newEnd = newStart + virtualText.length

              if (part.type === "file" && part.source?.text) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    text: {
                      ...part.source.text,
                      start: newStart,
                      end: newEnd,
                    },
                  },
                }
              }

              if (part.type === "agent" && part.source) {
                return {
                  ...part,
                  source: {
                    ...part.source,
                    start: newStart,
                    end: newEnd,
                  },
                }
              }

              return part
            })
            .filter((part) => part !== null)

          setStore("prompt", {
            input: content,
            // keep only the non-text parts because the text parts were
            // already expanded inline
            parts: updatedNonTextParts,
          })
          restoreExtmarksFromParts(updatedNonTextParts)
          input.cursorOffset = Bun.stringWidth(content)
        },
      },
      {
        title: "Skills",
        value: "prompt.skills",
        category: "Prompt",
        slash: {
          name: "skills",
        },
        onSelect: () => {
          dialog.replace(() => (
            <DialogSkill
              onSelect={(skill) => {
                input.setText(`/${skill} `)
                setStore("prompt", {
                  input: `/${skill} `,
                  parts: [],
                })
                input.gotoBufferEnd()
              }}
            />
          ))
        },
      },
      {
        title: "Voice mode",
        value: "prompt.voice",
        category: "Prompt",
        slash: {
          name: "voice",
        },
        onSelect: (dialog) => {
          setStore("mode", "voice")
          dialog.clear()
        },
      },
    ]
  })

  // Windows Terminal 1.25+ handles Ctrl+V on keydown when kitty events are
  // enabled, but still reports the kitty key-release event. Probe on release.
  if (process.platform === "win32") {
    useKeyboard(
      (evt) => {
        if (!input.focused) return
        if (evt.name === "v" && evt.ctrl && evt.eventType === "release") {
          command.trigger("prompt.paste")
        }
      },
      { release: true },
    )
  }

  const ref: PromptRef = {
    get focused() {
      return input.focused
    },
    get current() {
      return store.prompt
    },
    focus() {
      input.focus()
    },
    blur() {
      input.blur()
    },
    set(prompt) {
      input.setText(prompt.input)
      setStore("prompt", prompt)
      restoreExtmarksFromParts(prompt.parts)
      input.gotoBufferEnd()
    },
    reset() {
      input.clear()
      input.extmarks.clear()
      setStore("prompt", {
        input: "",
        parts: [],
      })
      setStore("extmarkToPartIndex", new Map())
    },
    submit() {
      submit()
    },
  }

  createEffect(() => {
    if (props.visible !== false) input?.focus()
    if (props.visible === false) input?.blur()
  })

  function restoreExtmarksFromParts(parts: PromptInfo["parts"]) {
    input.extmarks.clear()
    setStore("extmarkToPartIndex", new Map())

    parts.forEach((part, partIndex) => {
      let start = 0
      let end = 0
      let virtualText = ""
      let styleId: number | undefined

      if (part.type === "file" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = fileStyleId
      } else if (part.type === "agent" && part.source) {
        start = part.source.start
        end = part.source.end
        virtualText = part.source.value
        styleId = agentStyleId
      } else if (part.type === "text" && part.source?.text) {
        start = part.source.text.start
        end = part.source.text.end
        virtualText = part.source.text.value
        styleId = pasteStyleId
      }

      if (virtualText) {
        const extmarkId = input.extmarks.create({
          start,
          end,
          virtual: true,
          styleId,
          typeId: promptPartTypeId,
        })
        setStore("extmarkToPartIndex", (map: Map<number, number>) => {
          const newMap = new Map(map)
          newMap.set(extmarkId, partIndex)
          return newMap
        })
      }
    })
  }

  function syncExtmarksWithPromptParts() {
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    setStore(
      produce((draft) => {
        const newMap = new Map<number, number>()
        const newParts: typeof draft.prompt.parts = []

        for (const extmark of allExtmarks) {
          const partIndex = draft.extmarkToPartIndex.get(extmark.id)
          if (partIndex !== undefined) {
            const part = draft.prompt.parts[partIndex]
            if (part) {
              if (part.type === "agent" && part.source) {
                part.source.start = extmark.start
                part.source.end = extmark.end
              } else if (part.type === "file" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              } else if (part.type === "text" && part.source?.text) {
                part.source.text.start = extmark.start
                part.source.text.end = extmark.end
              }
              newMap.set(extmark.id, newParts.length)
              newParts.push(part)
            }
          }
        }

        draft.extmarkToPartIndex = newMap
        draft.prompt.parts = newParts
      }),
    )
  }

  command.register(() => [
    {
      title: "Stash prompt",
      value: "prompt.stash",
      category: "Prompt",
      enabled: !!store.prompt.input,
      onSelect: (dialog) => {
        if (!store.prompt.input) return
        stash.push({
          input: store.prompt.input,
          parts: store.prompt.parts,
        })
        input.extmarks.clear()
        input.clear()
        setStore("prompt", { input: "", parts: [] })
        setStore("extmarkToPartIndex", new Map())
        dialog.clear()
      },
    },
    {
      title: "Stash pop",
      value: "prompt.stash.pop",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        const entry = stash.pop()
        if (entry) {
          input.setText(entry.input)
          setStore("prompt", { input: entry.input, parts: entry.parts })
          restoreExtmarksFromParts(entry.parts)
          input.gotoBufferEnd()
        }
        dialog.clear()
      },
    },
    {
      title: "Stash list",
      value: "prompt.stash.list",
      category: "Prompt",
      enabled: stash.list().length > 0,
      onSelect: (dialog) => {
        dialog.replace(() => (
          <DialogStash
            onSelect={(entry) => {
              input.setText(entry.input)
              setStore("prompt", { input: entry.input, parts: entry.parts })
              restoreExtmarksFromParts(entry.parts)
              input.gotoBufferEnd()
            }}
          />
        ))
      },
    },
  ])

  function clear(opts?: { keepMode?: boolean }) {
    input.extmarks.clear()
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
    if (!opts?.keepMode && store.returnToVoice) {
      setStore("returnToVoice", false)
      setStore("mode", "voice")
    }
    input.clear()
  }

  function finish(mode: PromptMode) {
    history.append({
      ...store.prompt,
      mode,
    })
    clear()
    props.onSubmit?.()
  }

  async function submit() {
    if (props.disabled) return
    if (autocomplete?.visible) return
    if (!store.prompt.input) return
    const trimmed = store.prompt.input.trim()
    if (trimmed === "exit" || trimmed === "quit" || trimmed === ":q") {
      exit()
      return
    }
    let inputText = store.prompt.input

    // Expand pasted text inline before submitting
    const allExtmarks = input.extmarks.getAllForTypeId(promptPartTypeId)
    const sortedExtmarks = allExtmarks.sort((a: { start: number }, b: { start: number }) => b.start - a.start)

    for (const extmark of sortedExtmarks) {
      const partIndex = store.extmarkToPartIndex.get(extmark.id)
      if (partIndex !== undefined) {
        const part = store.prompt.parts[partIndex]
        if (part?.type === "text" && part.text) {
          const before = inputText.slice(0, extmark.start)
          const after = inputText.slice(extmark.end)
          inputText = before + part.text + after
        }
      }
    }

    // Filter out text parts (pasted content) since they're now expanded inline
    const nonTextParts = store.prompt.parts.filter((part) => part.type !== "text")

    // Capture mode before it gets reset
    const currentMode = store.mode
    const slash = parseSlash(inputText)

    if (slash?.name === "append") {
      command.trigger("session.append")
      clear({ keepMode: true })
      if (store.returnToVoice) {
        setStore("returnToVoice", false)
        setStore("mode", "voice")
      }
      return
    }

    const selectedModel = local.model.current()
    if (!selectedModel) {
      promptModelWarning()
      return
    }

    const variant = local.model.variant.current()

    const type =
      store.mode === "shell"
        ? "shell"
        : slash && sync.data.command.some((x) => x.name === slash.name)
          ? "command"
          : "normal"
    const draft: DeferredDraft = {
      id: MessageID.ascending(),
      sessionID: props.sessionID,
      input: inputText,
      parts: store.mode === "shell" ? [] : nonTextParts,
      type,
      command: type === "command" ? slash?.name : undefined,
      args: type === "command" ? slash?.args : undefined,
      model: {
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
      },
      agent: local.agent.current()?.name ?? "build",
      variant,
      vision: local.system.current()?.vision,
    }

    if (props.shouldDefer?.() && props.sessionID) {
      props.onDefer?.(draft)
      if (store.mode === "shell") setStore("mode", "normal")
      finish(currentMode)
      return
    }

    let sessionID = props.sessionID
    if (sessionID == null) {
      const res = await sdk.client.session.create({
        workspaceID: props.workspaceID,
      })

      if (res.error) {
        console.log("Creating a session failed:", res.error)

        toast.show({
          message: "Creating a session failed. Open console for more details.",
          variant: "error",
        })

        return
      }

      sessionID = res.data.id
      if (draft.agent === "auto") local.agent.auto.arm(sessionID)
    }

    void dispatchDraft({
      sdk,
      local,
      draft: {
        ...draft,
        sessionID,
      },
    }).catch(() => {})
    if (store.mode === "shell") setStore("mode", "normal")
    finish(currentMode)

    // temporary hack to make sure the message is sent
    if (!props.sessionID)
      setTimeout(() => {
        route.navigate({
          type: "session",
          sessionID,
        })
      }, 50)
    input.clear()
  }
  const exit = useExit()

  function pasteText(text: string, virtualText: string) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const extmarkEnd = extmarkStart + virtualText.length

    input.insertText(virtualText + " ")

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push({
          type: "text" as const,
          text,
          source: {
            text: {
              start: extmarkStart,
              end: extmarkEnd,
              value: virtualText,
            },
          },
        })
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
  }

  async function pasteImage(file: { filename?: string; content: string; mime: string }) {
    const currentOffset = input.visualCursor.offset
    const extmarkStart = currentOffset
    const count = store.prompt.parts.filter((x) => x.type === "file" && x.mime.startsWith("image/")).length
    const virtualText = `[Image ${count + 1}]`
    const extmarkEnd = extmarkStart + virtualText.length
    const textToInsert = virtualText + " "

    input.insertText(textToInsert)

    const extmarkId = input.extmarks.create({
      start: extmarkStart,
      end: extmarkEnd,
      virtual: true,
      styleId: pasteStyleId,
      typeId: promptPartTypeId,
    })

    const part: Omit<FilePart, "id" | "messageID" | "sessionID"> = {
      type: "file" as const,
      mime: file.mime,
      filename: file.filename,
      url: `data:${file.mime};base64,${file.content}`,
      source: {
        type: "file",
        path: file.filename ?? "",
        text: {
          start: extmarkStart,
          end: extmarkEnd,
          value: virtualText,
        },
      },
    }
    setStore(
      produce((draft) => {
        const partIndex = draft.prompt.parts.length
        draft.prompt.parts.push(part)
        draft.extmarkToPartIndex.set(extmarkId, partIndex)
      }),
    )
    return
  }

  const highlight = createMemo(() => {
    if (keybind.leader) return theme.border
    if (store.mode === "shell") return theme.primary
    return local.agent.color(local.agent.current().name)
  })

  const label = createMemo(() => {
    if (store.mode === "shell") return "Shell"
    const cur = local.agent.current()
    if (cur?.name === "auto") {
      const phase = local.agent.auto.phase()
      if (phase === "plan") return "Auto [Plan]"
      if (phase === "build") return "Auto [Build]"
      return "Auto"
    }
    return Locale.titlecase(cur?.name ?? "build")
  })

  const showVariant = createMemo(() => {
    const variants = local.model.variant.list()
    if (variants.length === 0) return false
    const current = local.model.variant.current()
    return !!current
  })

  const systemLabel = createMemo(() => {
    const cur = local.system.current()
    if (cur?.label) return cur.label
    return local.model.parsed().model
  })

  const fill = createMemo(() => "▄".repeat(Math.max(0, cols())))

  const systemProviders = createMemo(() => {
    const info = local.system.info()
    const parts: string[] = []
    if (info.provider) parts.push(info.provider.name)
    if (info.transcription && !info.hasAudioInput) parts.push("OpenAI STT")
    if (info.hasTts && !info.hasAudioOutput) parts.push("OpenAI TTS")
    if (info.hasVision && info.visionModel) parts.push(`${info.visionModel.name ?? "Vision"} Vision`)
    if (!parts.length) return ""
    return `(${parts.join(", ")})`
  })

  const placeholderText = createMemo(() => {
    if (store.mode === "voice") {
      return voice.placeholder()
    }
    if (props.showPlaceholder === false) return undefined
    if (store.mode === "shell") {
      if (!shell().length) return undefined
      const example = shell()[store.placeholder % shell().length]
      return `Run a command... "${example}"`
    }
    if (!list().length) return undefined
    return `Ask anything... "${list()[store.placeholder % list().length]}"`
  })

  const spinnerDef = createMemo(() => {
    const color = local.agent.color(local.agent.current().name)
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        // enableFading: false,
        minAlpha: 0.3,
      }),
    }
  })

  return (
    <>
      <Autocomplete
        sessionID={props.sessionID}
        ref={(r) => (autocomplete = r)}
        anchor={() => anchor}
        input={() => input}
        setPrompt={(cb) => {
          setStore("prompt", produce(cb))
        }}
        setExtmark={(partIndex, extmarkId) => {
          setStore("extmarkToPartIndex", (map: Map<number, number>) => {
            const newMap = new Map(map)
            newMap.set(extmarkId, partIndex)
            return newMap
          })
        }}
        value={store.prompt.input}
        fileStyleId={fileStyleId}
        agentStyleId={agentStyleId}
        promptPartTypeId={() => promptPartTypeId}
        onSlashSelect={() => {
          if (!store.returnToVoice) return
          // Check the textarea directly since onContentChange is async
          if (input.plainText) return
          setStore("returnToVoice", false)
          setStore("mode", "voice")
        }}
      />
      <box
        ref={(r) => {
          anchor = r
          if (!zed) return
          setTimeout(() => {
            if (r.isDestroyed) return
            setCols(Math.max(0, r.width - 1))
            renderer.requestRender()
          }, 0)
        }}
        onSizeChange={() => {
          if (!zed || !anchor || anchor.isDestroyed) return
          setCols(Math.max(0, anchor.width - 1))
          renderer.requestRender()
        }}
        visible={props.visible !== false}
      >
        <Show when={deferred().length > 0}>
          <box border={["top"]} borderColor={theme.warning} paddingLeft={2} paddingRight={2} flexDirection="column">
            <text fg={theme.warning}>
              <span style={{ fg: theme.warning, bold: true }}>QUEUED (append)</span>{" "}
              <span style={{ fg: theme.textMuted }}>{deferred().length}</span>
            </text>
            <For each={deferred().slice(0, 5)}>
              {(item) => (
                <text fg={theme.textMuted}>
                  {item.type === "command"
                    ? `/${item.command}`
                    : item.input.length > 60
                      ? item.input.slice(0, 57) + "..."
                      : item.input}
                </text>
              )}
            </For>
            <Show when={deferred().length > 5}>
              <text fg={theme.textMuted}>...and {deferred().length - 5} more</text>
            </Show>
          </box>
        </Show>
        <box
          border={["left"]}
          borderColor={highlight()}
          customBorderChars={{
            ...SplitBorder.customBorderChars,
            bottomLeft: "╹",
          }}
        >
          <box
            paddingLeft={2}
            paddingRight={2}
            paddingTop={1}
            flexShrink={0}
            backgroundColor={theme.backgroundElement}
            flexGrow={1}
          >
            <textarea
              placeholder={placeholderText()}
              placeholderColor={theme.textMuted}
              textColor={keybind.leader ? theme.textMuted : theme.text}
              focusedTextColor={keybind.leader ? theme.textMuted : theme.text}
              minHeight={1}
              maxHeight={6}
              onContentChange={() => {
                const value = input.plainText
                setStore("prompt", "input", value)
                autocomplete.onInput(value)
                syncExtmarksWithPromptParts()
              }}
              keyBindings={textareaKeybindings()}
              onKeyDown={async (e) => {
                if (props.disabled) {
                  e.preventDefault()
                  return
                }
                // Check clipboard for images before terminal-handled paste runs.
                // This helps terminals that forward Ctrl+V to the app; Windows
                // Terminal 1.25+ usually handles Ctrl+V before this path.
                if (keybind.match("input_paste", e)) {
                  const content = await Clipboard.read()
                  if (content?.mime.startsWith("image/")) {
                    if (store.mode === "voice") {
                      if (voice.recording()) voice.finish()
                      setStore("mode", "normal")
                    }
                    e.preventDefault()
                    await pasteImage({
                      filename: "clipboard",
                      mime: content.mime,
                      content: content.data,
                    })
                    return
                  }
                  if (store.mode === "voice") {
                    if (voice.recording()) voice.finish()
                    setStore("mode", "normal")
                    return
                  }
                  // If no image, let the default paste behavior continue
                }
                if (keybind.match("input_clear", e) && store.prompt.input !== "") {
                  input.clear()
                  input.extmarks.clear()
                  setStore("prompt", {
                    input: "",
                    parts: [],
                  })
                  setStore("extmarkToPartIndex", new Map())
                  return
                }
                if (keybind.match("app_exit", e)) {
                  if (store.prompt.input === "") {
                    await exit()
                    // Don't preventDefault - let textarea potentially handle the event
                    e.preventDefault()
                    return
                  }
                }
                if (e.name === "!" && input.visualCursor.offset === 0 && store.mode !== "voice") {
                  setStore("placeholder", randomIndex(shell().length))
                  setStore("mode", "shell")
                  e.preventDefault()
                  return
                }
                if (store.mode === "shell") {
                  if ((e.name === "backspace" && input.visualCursor.offset === 0) || e.name === "escape") {
                    if (store.returnToVoice) {
                      setStore("returnToVoice", false)
                      setStore("mode", "voice")
                    } else {
                      setStore("mode", "normal")
                    }
                    e.preventDefault()
                    return
                  }
                }
                if (
                  store.returnToVoice &&
                  store.mode === "normal" &&
                  e.name === "escape" &&
                  status().type === "idle" &&
                  !autocomplete.visible
                ) {
                  setStore("returnToVoice", false)
                  setStore("mode", "voice")
                  input.clear()
                  input.extmarks.clear()
                  setStore("prompt", { input: "", parts: [] })
                  setStore("extmarkToPartIndex", new Map())
                  e.preventDefault()
                  return
                }
                if (store.mode === "voice") {
                  if (e.name === "escape") return
                  if (e.name === "s" && props.speaking?.()) {
                    e.preventDefault()
                    props.cancelSpeech?.()
                    return
                  }
                  if (e.name === "space" && (e.shift || e.ctrl)) {
                    e.preventDefault()
                    if (voice.transcribing()) return
                    if (voice.recording()) {
                      voice.finish()
                      setStore("returnToVoice", true)
                      setStore("mode", "normal")
                    }
                    return
                  }
                  if (e.name === "space") {
                    e.preventDefault()
                    if (voice.transcribing()) return
                    voice.toggle()
                    return
                  }
                  if (e.name === "!" && input.visualCursor.offset === 0) {
                    if (voice.recording()) voice.finish()
                    setStore("returnToVoice", true)
                    setStore("placeholder", randomIndex(shell().length))
                    setStore("mode", "shell")
                    e.preventDefault()
                    return
                  }
                  if (e.name === "/" && input.visualCursor.offset === 0) {
                    if (voice.recording()) voice.finish()
                    setStore("returnToVoice", true)
                    setStore("mode", "normal")
                    // don't preventDefault — let "/" be typed for command autocomplete
                    return
                  }
                  if (e.name.length === 1 && !e.ctrl && !e.meta) {
                    if (voice.recording()) voice.finish()
                    setStore("mode", "normal")
                    return
                  }
                  e.preventDefault()
                  return
                }
                if (store.mode === "normal") autocomplete.onKeyDown(e)
                if (!autocomplete.visible) {
                  if (
                    (keybind.match("history_previous", e) && input.cursorOffset === 0) ||
                    (keybind.match("history_next", e) && input.cursorOffset === input.plainText.length)
                  ) {
                    const direction = keybind.match("history_previous", e) ? -1 : 1
                    const item = history.move(direction, input.plainText)

                    if (item) {
                      input.setText(item.input)
                      setStore("prompt", item)
                      setStore("returnToVoice", false)
                      setStore("mode", item.mode ?? "normal")
                      restoreExtmarksFromParts(item.parts)
                      e.preventDefault()
                      if (direction === -1) input.cursorOffset = 0
                      if (direction === 1) input.cursorOffset = input.plainText.length
                    }
                    return
                  }

                  if (keybind.match("history_previous", e) && input.visualCursor.visualRow === 0) input.cursorOffset = 0
                  if (keybind.match("history_next", e) && input.visualCursor.visualRow === input.height - 1)
                    input.cursorOffset = input.plainText.length
                }
              }}
              onSubmit={submit}
              onPaste={async (event: PasteEvent) => {
                if (props.disabled) {
                  event.preventDefault()
                  return
                }
                if (store.mode === "voice") {
                  if (voice.recording()) voice.finish()
                  setStore("mode", "normal")
                }

                // Normalize line endings at the boundary
                // Windows ConPTY/Terminal often sends CR-only newlines in bracketed paste
                // Replace CRLF first, then any remaining CR
                const normalizedText = decodePasteBytes(event.bytes).replace(/\r\n/g, "\n").replace(/\r/g, "\n")
                const pastedContent = normalizedText.trim()

                // Windows Terminal <1.25 can surface image-only clipboard as an
                // empty bracketed paste. Windows Terminal 1.25+ does not.
                if (!pastedContent) {
                  command.trigger("prompt.paste")
                  return
                }

                // trim ' from the beginning and end of the pasted content. just
                // ' and nothing else
                const filepath = pastedContent.replace(/^'+|'+$/g, "").replace(/\\ /g, " ")
                const isUrl = /^(https?):\/\//.test(filepath)
                if (!isUrl) {
                  try {
                    const mime = Filesystem.mimeType(filepath)
                    const filename = path.basename(filepath)
                    // Handle SVG as raw text content, not as base64 image
                    if (mime === "image/svg+xml") {
                      event.preventDefault()
                      const content = await Filesystem.readText(filepath).catch(() => {})
                      if (content) {
                        pasteText(content, `[SVG: ${filename ?? "image"}]`)
                        return
                      }
                    }
                    if (mime.startsWith("image/")) {
                      event.preventDefault()
                      const content = await Filesystem.readArrayBuffer(filepath)
                        .then((buffer) => Buffer.from(buffer).toString("base64"))
                        .catch(() => {})
                      if (content) {
                        await pasteImage({
                          filename,
                          mime,
                          content,
                        })
                        return
                      }
                    }
                  } catch {}
                }

                const lineCount = (pastedContent.match(/\n/g)?.length ?? 0) + 1
                if (
                  (lineCount >= 3 || pastedContent.length > 150) &&
                  !sync.data.config.experimental?.disable_paste_summary
                ) {
                  event.preventDefault()
                  pasteText(pastedContent, `[Pasted ~${lineCount} lines]`)
                  return
                }

                // Force layout update and render for the pasted content
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.getLayoutNode().markDirty()
                  renderer.requestRender()
                }, 0)
              }}
              ref={(r: TextareaRenderable) => {
                input = r
                if (promptPartTypeId === 0) {
                  promptPartTypeId = input.extmarks.registerType("prompt-part")
                }
                props.ref?.(ref)
                setTimeout(() => {
                  // setTimeout is a workaround and needs to be addressed properly
                  if (!input || input.isDestroyed) return
                  input.cursorColor = theme.text
                }, 0)
              }}
              onMouseDown={(r: MouseEvent) => r.target?.focus()}
              focusedBackgroundColor={theme.backgroundElement}
              cursorColor={theme.text}
              showCursor={store.mode !== "voice"}
              syntaxStyle={syntax()}
            />
            <box flexDirection="row" flexShrink={0} paddingTop={1} gap={1}>
              <text fg={highlight()}>{label()} </text>
              <Show when={store.mode !== "shell"}>
                <box flexDirection="row" gap={1}>
                  <text flexShrink={0} fg={keybind.leader ? theme.textMuted : theme.text}>
                    {systemLabel()}
                  </text>
                  <Show when={showVariant()}>
                    <text fg={theme.error}>{local.model.variant.current()}</text>
                  </Show>
                  <text fg={theme.textMuted}>{systemProviders()}</text>
                </box>
              </Show>
            </box>
          </box>
        </box>
        <Show when={!zed}>
          <box
            height={1}
            border={["left"]}
            borderColor={highlight()}
            customBorderChars={{
              ...EmptyBorder,
              vertical: theme.backgroundElement.a !== 0 ? "╹" : " ",
            }}
          >
            <box
              height={1}
              border={["bottom"]}
              borderColor={theme.backgroundElement}
              customBorderChars={
                theme.backgroundElement.a !== 0
                  ? {
                      ...EmptyBorder,
                      horizontal: "▀",
                    }
                  : {
                      ...EmptyBorder,
                      horizontal: " ",
                    }
              }
            />
          </box>
        </Show>
        <Show when={zed}>
          <box height={1} flexDirection="row">
            <text fg={highlight()}>╹</text>
            <text fg={theme.background} bg={theme.backgroundElement} selectable={false}>
              {theme.backgroundElement.a !== 0 ? fill() : " ".repeat(Math.max(0, cols()))}
            </text>
          </box>
        </Show>
        <box flexDirection="row" justifyContent="space-between">
          <Show when={status().type !== "idle"} fallback={props.hint ?? <text />}>
            <box
              flexDirection="row"
              gap={1}
              flexGrow={1}
              justifyContent={status().type === "retry" ? "space-between" : "flex-start"}
            >
              <box flexShrink={0} flexDirection="row" gap={1}>
                <box marginLeft={1}>
                  <Show when={kv.get("animations_enabled", true)} fallback={<text fg={theme.textMuted}>[⋯]</text>}>
                    <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                  </Show>
                </box>
                <box flexDirection="row" gap={1} flexShrink={0}>
                  {(() => {
                    const retry = createMemo(() => {
                      const s = status()
                      if (s.type !== "retry") return
                      return s
                    })
                    const message = createMemo(() => {
                      const r = retry()
                      if (!r) return
                      if (r.message.includes("exceeded your current quota") && r.message.includes("gemini"))
                        return "gemini is way too hot right now"
                      if (r.message.length > 80) return r.message.slice(0, 80) + "..."
                      return r.message
                    })
                    const isTruncated = createMemo(() => {
                      const r = retry()
                      if (!r) return false
                      return r.message.length > 120
                    })
                    const [seconds, setSeconds] = createSignal(0)
                    onMount(() => {
                      const timer = setInterval(() => {
                        const next = retry()?.next
                        if (next) setSeconds(Math.round((next - Date.now()) / 1000))
                      }, 1000)

                      onCleanup(() => {
                        clearInterval(timer)
                      })
                    })
                    const handleMessageClick = () => {
                      const r = retry()
                      if (!r) return
                      if (isTruncated()) {
                        DialogAlert.show(dialog, "Retry Error", r.message)
                      }
                    }

                    const retryText = () => {
                      const r = retry()
                      if (!r) return ""
                      const baseMessage = message()
                      const truncatedHint = isTruncated() ? " (click to expand)" : ""
                      const duration = formatDuration(seconds())
                      const retryInfo = ` [retrying ${duration ? `in ${duration} ` : ""}attempt #${r.attempt}]`
                      return baseMessage + truncatedHint + retryInfo
                    }

                    return (
                      <Show when={retry()}>
                        <box onMouseUp={handleMessageClick}>
                          <text fg={theme.error}>{retryText()}</text>
                        </box>
                      </Show>
                    )
                  })()}
                </box>
              </box>
              <text fg={store.interrupt > 0 ? theme.primary : theme.text}>
                esc{" "}
                <span style={{ fg: store.interrupt > 0 ? theme.primary : theme.textMuted }}>
                  {store.interrupt > 0 ? "again to interrupt" : "interrupt"}
                </span>
              </text>
            </box>
          </Show>
          <Show when={status().type !== "retry"}>
            <box gap={2} flexDirection="row">
              <Show when={props.appendMode?.()}>
                <text fg={theme.warning}>
                  append{" "}
                  <span style={{ fg: theme.textMuted }}>
                    {deferred().length > 0 ? `${deferred().length} queued` : "on"}
                  </span>
                </text>
              </Show>
              <Switch>
                <Match when={store.mode === "normal"}>
                  <Show when={local.model.variant.list().length > 0}>
                    <text fg={theme.text}>
                      {keybind.print("variant_cycle")} <span style={{ fg: theme.textMuted }}>variants</span>
                    </text>
                  </Show>
                  <text fg={theme.text}>
                    {keybind.print("agent_cycle")} <span style={{ fg: theme.textMuted }}>agents</span>
                  </text>
                  <Show when={local.system.list().length > 1}>
                    <text fg={theme.text}>
                      {keybind.print("system_cycle")} <span style={{ fg: theme.textMuted }}>systems</span>
                    </text>
                  </Show>
                  <text fg={theme.text}>
                    {keybind.print("command_list")} <span style={{ fg: theme.textMuted }}>commands</span>
                  </text>
                </Match>
                <Match when={store.mode === "shell"}>
                  <text fg={theme.text}>
                    esc <span style={{ fg: theme.textMuted }}>exit shell mode</span>
                  </text>
                </Match>
                <Match when={store.mode === "voice"}>
                  <Show when={props.speaking?.()}>
                    <text fg={theme.text}>
                      s <span style={{ fg: theme.textMuted }}>stop speaking</span>
                    </text>
                  </Show>
                  <text fg={theme.text}>
                    space{" "}
                    <span style={{ fg: theme.textMuted }}>
                      {voice.recording() ? "stop + send" : voice.transcribing() ? "transcribing..." : "record"}
                    </span>
                  </text>
                  <Show when={voice.recording()}>
                    <text fg={theme.text}>
                      shift+space <span style={{ fg: theme.textMuted }}>stop + edit</span>
                    </text>
                  </Show>
                  <text fg={theme.text}>
                    type <span style={{ fg: theme.textMuted }}>edit</span>
                  </text>
                  <text fg={theme.text}>
                    ! <span style={{ fg: theme.textMuted }}>shell</span>
                  </text>
                  <text fg={theme.text}>
                    / <span style={{ fg: theme.textMuted }}>command</span>
                  </text>
                </Match>
              </Switch>
            </box>
          </Show>
        </box>
      </box>
    </>
  )
}
