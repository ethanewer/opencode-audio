import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { Portal, useKeyboard, useTerminalDimensions, type JSX } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { useTheme, selectedForeground } from "../../context/theme"
import type { PermissionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"
import { useSync } from "../../context/sync"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"
import { Keybind } from "@/util/keybind"
import { Locale } from "@/util/locale"
import { Global } from "@/global"
import { useDialog } from "../../ui/dialog"
import { useTuiConfig } from "../../context/tui-config"
import { usePromptRef } from "../../context/prompt"
import { useLocal } from "../../context/local"
import { useVoice } from "../../util/voice"
import { useToast } from "../../ui/toast"

type PermissionStage = "permission" | "always" | "reject"

function normalizePath(input?: string) {
  if (!input) return ""

  const cwd = process.cwd()
  const home = Global.Path.home
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use ~ or absolute
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~")
  }
  return absolute
}

function filetype(input?: string) {
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

function EditBody(props: { request: PermissionRequest }) {
  const themeState = useTheme()
  const theme = themeState.theme
  const syntax = themeState.syntax
  const config = useTuiConfig()
  const dimensions = useTerminalDimensions()

  const filepath = createMemo(() => (props.request.metadata?.filepath as string) ?? "")
  const diff = createMemo(() => (props.request.metadata?.diff as string) ?? "")

  const view = createMemo(() => {
    const diffStyle = config.diff_style
    if (diffStyle === "stacked") return "unified"
    return dimensions().width > 120 ? "split" : "unified"
  })

  const ft = createMemo(() => filetype(filepath()))

  return (
    <box flexDirection="column" gap={1}>
      <Show when={diff()}>
        <scrollbox
          height="100%"
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <diff
            diff={diff()}
            view={view()}
            filetype={ft()}
            syntaxStyle={syntax()}
            showLineNumbers={true}
            width="100%"
            wrapMode="word"
            fg={theme.text}
            addedBg={theme.diffAddedBg}
            removedBg={theme.diffRemovedBg}
            contextBg={theme.diffContextBg}
            addedSignColor={theme.diffHighlightAdded}
            removedSignColor={theme.diffHighlightRemoved}
            lineNumberFg={theme.diffLineNumber}
            lineNumberBg={theme.diffContextBg}
            addedLineNumberBg={theme.diffAddedLineNumberBg}
            removedLineNumberBg={theme.diffRemovedLineNumberBg}
          />
        </scrollbox>
      </Show>
      <Show when={!diff()}>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>No diff provided</text>
        </box>
      </Show>
    </box>
  )
}

function TextBody(props: { title: string; description?: string; icon?: string }) {
  const { theme } = useTheme()
  return (
    <>
      <box flexDirection="row" gap={1} paddingLeft={1}>
        <Show when={props.icon}>
          <text fg={theme.textMuted} flexShrink={0}>
            {props.icon}
          </text>
        </Show>
        <text fg={theme.textMuted}>{props.title}</text>
      </box>
      <Show when={props.description}>
        <box paddingLeft={1}>
          <text fg={theme.text}>{props.description}</text>
        </box>
      </Show>
    </>
  )
}

const PERMISSION_VOICE = ["no", "yes", "allow always"] as const

function permissionVoiceLabel(option: string | null) {
  if (option === "no") return "Reject"
  if (option === "yes") return "Allow once"
  if (option === "allow always") return "Allow always"
  return "No match"
}

function PermissionTriVoicePrompt(props: {
  header: JSX.Element
  body: JSX.Element
  fullscreen?: boolean
  onNo: () => void
  onYes: () => void
  onAlways: () => void
}) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()
  const opts = { once: "Allow once", always: "Allow always", reject: "Reject" } as const
  const keys = Object.keys(opts) as (keyof typeof opts)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const diffKey = Keybind.parse("ctrl+f")[0]
  const narrow = createMemo(() => dimensions().width < 80)
  const dialog = useDialog()
  const promptRef = usePromptRef()
  const toast = useToast()
  const sdk = useSDK()
  const local = useLocal()
  const voiced = createMemo(() => promptRef.mode === "voice")
  const [classifying, setClassifying] = createSignal(false)
  const [voiceTrace, setVoiceTrace] = createSignal<{
    transcript: string
    matched: string
    confidence: number | null
  } | null>(null)

  async function handleVoice(text: string) {
    const trimmed = text.trim()
    if (!trimmed) return
    if (!voiced()) return
    const model = local.model.current()
    if (!model || !sdk.classify) {
      toast.show({ variant: "warning", message: "Select a model to use voice for permissions", duration: 3000 })
      return
    }
    setClassifying(true)
    try {
      const result = await sdk.classify({
        providerID: model.providerID,
        modelID: model.modelID,
        transcript: text,
        options: [...PERMISSION_VOICE],
        question: "Permission: allow once, allow always, or reject.",
      })
      setClassifying(false)
      if (!voiced()) return
      const ok = Boolean(result.option && result.confidence !== 0)
      const conf = typeof result.confidence === "number" ? result.confidence : null
      setVoiceTrace({
        transcript: trimmed,
        matched: ok ? permissionVoiceLabel(result.option) : "No match",
        confidence: conf,
      })
      if (!result.option || result.confidence === 0) {
        toast.show({ variant: "warning", message: "Didn't catch that, try again", duration: 2000 })
        return
      }
      if (result.option === "no") props.onNo()
      else if (result.option === "yes") props.onYes()
      else if (result.option === "allow always") props.onAlways()
    } catch (err) {
      setClassifying(false)
      if (!voiced()) return
      setVoiceTrace({
        transcript: trimmed,
        matched: "Classification failed",
        confidence: null,
      })
      toast.show({
        variant: "error",
        title: "Classification failed",
        message: err instanceof Error ? err.message : "An unknown error occurred",
        duration: 5000,
      })
    }
  }

  const voice = useVoice({ onResult: handleVoice })

  createEffect(() => {
    if (voice.recording()) setVoiceTrace(null)
  })

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (voiced()) {
      if (evt.name === "escape" || keybind.match("app_exit", evt)) {
        evt.preventDefault()
        if (voice.recording()) {
          voice.cancel()
          return
        }
        props.onNo()
        return
      }
      if (evt.name === "space") {
        evt.preventDefault()
        if (classifying()) return
        voice.toggle()
        return
      }
    }

    if (evt.name === "left" || evt.name == "h") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx - 1 + keys.length) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "right" || evt.name == "l") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx + 1) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "return") {
      evt.preventDefault()
      if (store.selected === "once") props.onYes()
      if (store.selected === "always") props.onAlways()
      if (store.selected === "reject") props.onNo()
    }

    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      props.onNo()
    }

    if (props.fullscreen && diffKey && Keybind.match(diffKey, keybind.parse(evt))) {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("expanded", (v) => !v)
    }
  })

  const hint = createMemo(() => (store.expanded ? "minimize" : "fullscreen"))

  const content = () => (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <box paddingLeft={1} flexShrink={0}>
          {props.header}
        </box>
        {props.body}
        <Show when={voiced() && classifying()}>
          <box paddingLeft={1}>
            <text fg={theme.textMuted}>Processing...</text>
          </box>
        </Show>
        <Show when={voiced() && !classifying() && (voice.recording() || voice.transcribing())}>
          <box paddingLeft={1}>
            <text fg={theme.textMuted}>{voice.placeholder()}</text>
          </box>
        </Show>
        <Show when={voiced() && voiceTrace()}>
          <box paddingLeft={1} gap={0} flexDirection="column">
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.textMuted }}>Heard: </span>
              <span style={{ fg: theme.text }}>"{voiceTrace()!.transcript}"</span>
            </text>
            <text fg={theme.textMuted}>
              <span style={{ fg: theme.textMuted }}>Matched: </span>
              <span style={{ fg: theme.secondary }}>{voiceTrace()!.matched}</span>
              <Show when={voiceTrace()!.confidence != null}>
                <span style={{ fg: theme.textMuted }}>
                  {" "}
                  · {Math.round((voiceTrace()!.confidence ?? 0) * 100)}%
                </span>
              </Show>
            </text>
          </box>
        </Show>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={keys}>
            {(option) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option === store.selected ? theme.warning : theme.backgroundMenu}
                onMouseOver={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  if (option === "once") props.onYes()
                  if (option === "always") props.onAlways()
                  if (option === "reject") props.onNo()
                }}
              >
                <text fg={option === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}>
                  {opts[option]}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={voiced()}>
            <text fg={theme.text}>
              space <span style={{ fg: theme.textMuted }}>{voice.recording() ? "stop" : "record"}</span>
            </text>
          </Show>
          <Show when={props.fullscreen}>
            <text fg={theme.text}>
              {"ctrl+f"} <span style={{ fg: theme.textMuted }}>{hint()}</span>
            </text>
          </Show>
          <Show when={!voiced()}>
            <text fg={theme.text}>
              {"⇆"} <span style={{ fg: theme.textMuted }}>select</span>
            </text>
          </Show>
          <Show when={!voiced()}>
            <text fg={theme.text}>
              enter <span style={{ fg: theme.textMuted }}>confirm</span>
            </text>
          </Show>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}

export function PermissionPrompt(props: { request: PermissionRequest }) {
  const sdk = useSDK()
  const sync = useSync()
  const [store, setStore] = createStore({
    stage: "permission" as PermissionStage,
  })

  const session = createMemo(() => sync.data.session.find((s) => s.id === props.request.sessionID))

  const input = createMemo(() => {
    const tool = props.request.tool
    if (!tool) return {}
    const parts = sync.data.part[tool.messageID] ?? []
    for (const part of parts) {
      if (part.type === "tool" && part.callID === tool.callID && part.state.status !== "pending") {
        return part.state.input ?? {}
      }
    }
    return {}
  })

  const { theme } = useTheme()

  return (
    <Switch>
      <Match when={store.stage === "always"}>
        <Prompt
          title="Always allow"
          body={
            <Switch>
              <Match when={props.request.always.length === 1 && props.request.always[0] === "*"}>
                <TextBody title={"This will allow " + props.request.permission + " until OpenCode is restarted."} />
              </Match>
              <Match when={true}>
                <box paddingLeft={1} gap={1}>
                  <text fg={theme.textMuted}>This will allow the following patterns until OpenCode is restarted</text>
                  <box>
                    <For each={props.request.always}>
                      {(pattern) => (
                        <text fg={theme.text}>
                          {"- "}
                          {pattern}
                        </text>
                      )}
                    </For>
                  </box>
                </box>
              </Match>
            </Switch>
          }
          options={{ confirm: "Confirm", cancel: "Cancel" }}
          escapeKey="cancel"
          onSelect={(option) => {
            setStore("stage", "permission")
            if (option === "cancel") return
            sdk.client.permission.reply({
              reply: "always",
              requestID: props.request.id,
            })
          }}
        />
      </Match>
      <Match when={store.stage === "reject"}>
        <RejectPrompt
          onConfirm={(message) => {
            sdk.client.permission.reply({
              reply: "reject",
              requestID: props.request.id,
              message: message || undefined,
            })
          }}
          onCancel={() => {
            setStore("stage", "permission")
          }}
        />
      </Match>
      <Match when={store.stage === "permission"}>
        {(() => {
          const info = () => {
            const permission = props.request.permission
            const data = input()

            if (permission === "edit") {
              const raw = props.request.metadata?.filepath
              const filepath = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `Edit ${normalizePath(filepath)}`,
                body: <EditBody request={props.request} />,
              }
            }

            if (permission === "read") {
              const raw = data.filePath
              const filePath = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `Read ${normalizePath(filePath)}`,
                body: (
                  <Show when={filePath}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Path: " + normalizePath(filePath)}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "glob") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                icon: "✱",
                title: `Glob "${pattern}"`,
                body: (
                  <Show when={pattern}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "grep") {
              const pattern = typeof data.pattern === "string" ? data.pattern : ""
              return {
                icon: "✱",
                title: `Grep "${pattern}"`,
                body: (
                  <Show when={pattern}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Pattern: " + pattern}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "list") {
              const raw = data.path
              const dir = typeof raw === "string" ? raw : ""
              return {
                icon: "→",
                title: `List ${normalizePath(dir)}`,
                body: (
                  <Show when={dir}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Path: " + normalizePath(dir)}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "bash") {
              const title =
                typeof data.description === "string" && data.description ? data.description : "Shell command"
              const command = typeof data.command === "string" ? data.command : ""
              return {
                icon: "#",
                title,
                body: (
                  <Show when={command}>
                    <box paddingLeft={1}>
                      <text fg={theme.text}>{"$ " + command}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "task") {
              const type = typeof data.subagent_type === "string" ? data.subagent_type : "Unknown"
              const desc = typeof data.description === "string" ? data.description : ""
              return {
                icon: "#",
                title: `${Locale.titlecase(type)} Task`,
                body: (
                  <Show when={desc}>
                    <box paddingLeft={1}>
                      <text fg={theme.text}>{"◉ " + desc}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "webfetch") {
              const url = typeof data.url === "string" ? data.url : ""
              return {
                icon: "%",
                title: `WebFetch ${url}`,
                body: (
                  <Show when={url}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"URL: " + url}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "websearch") {
              const query = typeof data.query === "string" ? data.query : ""
              return {
                icon: "◈",
                title: `Exa Web Search "${query}"`,
                body: (
                  <Show when={query}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Query: " + query}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "codesearch") {
              const query = typeof data.query === "string" ? data.query : ""
              return {
                icon: "◇",
                title: `Exa Code Search "${query}"`,
                body: (
                  <Show when={query}>
                    <box paddingLeft={1}>
                      <text fg={theme.textMuted}>{"Query: " + query}</text>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "external_directory") {
              const meta = props.request.metadata ?? {}
              const parent = typeof meta["parentDir"] === "string" ? meta["parentDir"] : undefined
              const filepath = typeof meta["filepath"] === "string" ? meta["filepath"] : undefined
              const pattern = props.request.patterns?.[0]
              const derived =
                typeof pattern === "string" ? (pattern.includes("*") ? path.dirname(pattern) : pattern) : undefined

              const raw = parent ?? filepath ?? derived
              const dir = normalizePath(raw)
              const patterns = (props.request.patterns ?? []).filter((p): p is string => typeof p === "string")

              return {
                icon: "←",
                title: `Access external directory ${dir}`,
                body: (
                  <Show when={patterns.length > 0}>
                    <box paddingLeft={1} gap={1}>
                      <text fg={theme.textMuted}>Patterns</text>
                      <box>
                        <For each={patterns}>{(p) => <text fg={theme.text}>{"- " + p}</text>}</For>
                      </box>
                    </box>
                  </Show>
                ),
              }
            }

            if (permission === "doom_loop") {
              return {
                icon: "⟳",
                title: "Continue after repeated failures",
                body: (
                  <box paddingLeft={1}>
                    <text fg={theme.textMuted}>This keeps the session running despite repeated failures.</text>
                  </box>
                ),
              }
            }

            return {
              icon: "⚙",
              title: `Call tool ${permission}`,
              body: (
                <box paddingLeft={1}>
                  <text fg={theme.textMuted}>{"Tool: " + permission}</text>
                </box>
              ),
            }
          }

          const current = info()

          const header = () => (
            <box flexDirection="column" gap={0}>
              <box flexDirection="row" gap={1} flexShrink={0}>
                <text fg={theme.warning}>{"△"}</text>
                <text fg={theme.text}>Permission required</text>
              </box>
              <box flexDirection="row" gap={1} paddingLeft={2} flexShrink={0}>
                <text fg={theme.textMuted} flexShrink={0}>
                  {current.icon}
                </text>
                <text fg={theme.text}>{current.title}</text>
              </box>
            </box>
          )

          const body = (
            <PermissionTriVoicePrompt
              header={header()}
              body={current.body}
              fullscreen
              onAlways={() => {
                setStore("stage", "always")
              }}
              onNo={() => {
                if (session()?.parentID) {
                  setStore("stage", "reject")
                  return
                }
                sdk.client.permission.reply({
                  reply: "reject",
                  requestID: props.request.id,
                })
              }}
              onYes={() => {
                sdk.client.permission.reply({
                  reply: "once",
                  requestID: props.request.id,
                })
              }}
            />
          )

          return body
        })()}
      </Match>
    </Switch>
  )
}

function RejectPrompt(props: { onConfirm: (message: string) => void; onCancel: () => void }) {
  let input: TextareaRenderable
  const { theme } = useTheme()
  const keybind = useKeybind()
  const textareaKeybindings = useTextareaKeybindings()
  const dimensions = useTerminalDimensions()
  const narrow = createMemo(() => dimensions().width < 80)
  const dialog = useDialog()
  const promptRef = usePromptRef()
  const voiced = createMemo(() => promptRef.mode === "voice")

  const voice = useVoice({
    onResult(text) {
      if (!text.trim()) return
      props.onConfirm(text)
    },
  })

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (voiced()) {
      if (evt.name === "escape" || keybind.match("app_exit", evt)) {
        evt.preventDefault()
        if (voice.recording()) {
          voice.cancel()
          return
        }
        props.onCancel()
        return
      }
      if (evt.name === "space") {
        evt.preventDefault()
        voice.toggle()
        return
      }
    }

    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      props.onCancel()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      props.onConfirm(input.plainText)
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.error}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <box flexDirection="row" gap={1} paddingLeft={1}>
          <text fg={theme.error}>{"△"}</text>
          <text fg={theme.text}>Reject permission</text>
        </box>
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>Tell OpenCode what to do differently</text>
        </box>
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
        gap={1}
      >
        <Show when={voiced()}>
          <text fg={theme.textMuted}>{voice.placeholder()}</text>
        </Show>
        <Show when={!voiced()}>
          <textarea
            ref={(val: TextareaRenderable) => (input = val)}
            focused
            textColor={theme.text}
            focusedTextColor={theme.text}
            cursorColor={theme.primary}
            keyBindings={textareaKeybindings()}
          />
        </Show>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={voiced()}>
            <text fg={theme.text}>
              space <span style={{ fg: theme.textMuted }}>{voice.recording() ? "stop" : "record"}</span>
            </text>
          </Show>
          <Show when={!voiced()}>
            <text fg={theme.text}>
              enter <span style={{ fg: theme.textMuted }}>confirm</span>
            </text>
          </Show>
          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>cancel</span>
          </text>
        </box>
      </box>
    </box>
  )
}

function Prompt<const T extends Record<string, string>>(props: {
  title: string
  header?: JSX.Element
  body: JSX.Element
  options: T
  escapeKey?: keyof T
  fullscreen?: boolean
  onSelect: (option: keyof T) => void
}) {
  const { theme } = useTheme()
  const keybind = useKeybind()
  const dimensions = useTerminalDimensions()
  const keys = Object.keys(props.options) as (keyof T)[]
  const [store, setStore] = createStore({
    selected: keys[0],
    expanded: false,
  })
  const diffKey = Keybind.parse("ctrl+f")[0]
  const narrow = createMemo(() => dimensions().width < 80)
  const dialog = useDialog()

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (evt.name === "left" || evt.name == "h") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx - 1 + keys.length) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "right" || evt.name == "l") {
      evt.preventDefault()
      const idx = keys.indexOf(store.selected)
      const next = keys[(idx + 1) % keys.length]
      setStore("selected", next)
    }

    if (evt.name === "return") {
      evt.preventDefault()
      props.onSelect(store.selected)
    }

    if (props.escapeKey && (evt.name === "escape" || keybind.match("app_exit", evt))) {
      evt.preventDefault()
      props.onSelect(props.escapeKey)
    }

    if (props.fullscreen && diffKey && Keybind.match(diffKey, keybind.parse(evt))) {
      evt.preventDefault()
      evt.stopPropagation()
      setStore("expanded", (v) => !v)
    }
  })

  const hint = createMemo(() => (store.expanded ? "minimize" : "fullscreen"))

  const content = () => (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.warning}
      customBorderChars={SplitBorder.customBorderChars}
      {...(store.expanded
        ? { top: dimensions().height * -1 + 1, bottom: 1, left: 2, right: 2, position: "absolute" }
        : {
            top: 0,
            maxHeight: 15,
            bottom: 0,
            left: 0,
            right: 0,
            position: "relative",
          })}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1} flexGrow={1}>
        <Show
          when={props.header}
          fallback={
            <box flexDirection="row" gap={1} paddingLeft={1} flexShrink={0}>
              <text fg={theme.warning}>{"△"}</text>
              <text fg={theme.text}>{props.title}</text>
            </box>
          }
        >
          <box paddingLeft={1} flexShrink={0}>
            {props.header}
          </box>
        </Show>
        {props.body}
      </box>
      <box
        flexDirection={narrow() ? "column" : "row"}
        flexShrink={0}
        gap={1}
        paddingTop={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        backgroundColor={theme.backgroundElement}
        justifyContent={narrow() ? "flex-start" : "space-between"}
        alignItems={narrow() ? "flex-start" : "center"}
      >
        <box flexDirection="row" gap={1} flexShrink={0}>
          <For each={keys}>
            {(option) => (
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={option === store.selected ? theme.warning : theme.backgroundMenu}
                onMouseOver={() => setStore("selected", option)}
                onMouseUp={() => {
                  setStore("selected", option)
                  props.onSelect(option)
                }}
              >
                <text fg={option === store.selected ? selectedForeground(theme, theme.warning) : theme.textMuted}>
                  {props.options[option]}
                </text>
              </box>
            )}
          </For>
        </box>
        <box flexDirection="row" gap={2} flexShrink={0}>
          <Show when={props.fullscreen}>
            <text fg={theme.text}>
              {"ctrl+f"} <span style={{ fg: theme.textMuted }}>{hint()}</span>
            </text>
          </Show>
          <text fg={theme.text}>
            {"⇆"} <span style={{ fg: theme.textMuted }}>select</span>
          </text>
          <text fg={theme.text}>
            enter <span style={{ fg: theme.textMuted }}>confirm</span>
          </text>
        </box>
      </box>
    </box>
  )

  return (
    <Show when={!store.expanded} fallback={<Portal>{content()}</Portal>}>
      {content()}
    </Show>
  )
}
