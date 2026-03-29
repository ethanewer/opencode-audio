import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TextareaRenderable } from "@opentui/core"
import { useKeybind } from "../../context/keybind"
import { selectedForeground, tint, useTheme } from "../../context/theme"
import type { QuestionAnswer, QuestionRequest } from "@opencode-ai/sdk/v2"
import { useSDK } from "../../context/sdk"
import { SplitBorder } from "../../component/border"
import { useTextareaKeybindings } from "../../component/textarea-keybindings"
import { useDialog } from "../../ui/dialog"
import { usePromptRef } from "../../context/prompt"
import { useVoice } from "../../util/voice"
import { useToast } from "../../ui/toast"
import { useLocal } from "../../context/local"

export function QuestionPrompt(props: { request: QuestionRequest }) {
  const sdk = useSDK()
  const { theme } = useTheme()
  const keybind = useKeybind()
  const bindings = useTextareaKeybindings()

  const questions = createMemo(() => props.request.questions)
  const single = createMemo(() => questions().length === 1 && questions()[0]?.multiple !== true)
  const promptRef = usePromptRef()
  const voiced = createMemo(() => promptRef.mode === "voice")
  const tabs = createMemo(() => (voiced() ? questions().length : single() ? 1 : questions().length + 1))
  const [tabHover, setTabHover] = createSignal<number | "confirm" | null>(null)
  const [store, setStore] = createStore({
    tab: 0,
    answers: [] as QuestionAnswer[],
    custom: [] as string[],
    selected: 0,
    editing: false,
  })

  let textarea: TextareaRenderable | undefined

  const question = createMemo(() => questions()[store.tab])
  const last = createMemo(() => store.tab === questions().length - 1)
  const confirm = createMemo(() => !voiced() && !single() && store.tab === questions().length)
  const options = createMemo(() => question()?.options ?? [])
  const custom = createMemo(() => question()?.custom !== false)
  const other = createMemo(() => custom() && store.selected === options().length)
  const input = createMemo(() => store.custom[store.tab] ?? "")
  const multi = createMemo(() => question()?.multiple === true)
  const customPicked = createMemo(() => {
    const value = input()
    if (!value) return false
    return store.answers[store.tab]?.includes(value) ?? false
  })

  function submit() {
    const answers = questions().map((_, i) => store.answers[i] ?? [])
    sdk.client.question.reply({
      requestID: props.request.id,
      answers,
    })
  }

  function reject() {
    sdk.client.question.reject({
      requestID: props.request.id,
    })
  }

  function pick(answer: string, custom: boolean = false) {
    const answers = [...store.answers]
    answers[store.tab] = [answer]
    setStore("answers", answers)
    if (custom) {
      const inputs = [...store.custom]
      inputs[store.tab] = answer
      setStore("custom", inputs)
    }
    if (single()) {
      sdk.client.question.reply({
        requestID: props.request.id,
        answers: [[answer]],
      })
      return
    }
    if (voiced()) {
      if (!last()) {
        setStore("tab", store.tab + 1)
        setStore("selected", 0)
        return
      }
      if (!multi()) {
        submit()
        return
      }
      if (custom) {
        submit()
      }
      return
    }
    setStore("tab", store.tab + 1)
    setStore("selected", 0)
  }

  function toggle(answer: string) {
    const existing = store.answers[store.tab] ?? []
    const next = [...existing]
    const index = next.indexOf(answer)
    if (index === -1) next.push(answer)
    if (index !== -1) next.splice(index, 1)
    const answers = [...store.answers]
    answers[store.tab] = next
    setStore("answers", answers)
  }

  function moveTo(index: number) {
    setStore("selected", index)
  }

  function selectTab(index: number) {
    setStore("tab", index)
    setStore("selected", 0)
  }

  function selectOption() {
    if (other()) {
      if (!multi()) {
        setStore("editing", true)
        return
      }
      const value = input()
      if (value && customPicked()) {
        toggle(value)
        return
      }
      setStore("editing", true)
      return
    }
    const opt = options()[store.selected]
    if (!opt) return
    if (multi()) {
      toggle(opt.label)
      return
    }
    pick(opt.label)
  }

  const dialog = useDialog()
  const toast = useToast()
  const local = useLocal()

  const [classifying, setClassifying] = createSignal(false)
  const [voiceTrace, setVoiceTrace] = createSignal<{
    transcript: string
    matched: string
    confidence: number | null
  } | null>(null)

  async function handleVoiceResult(text: string) {
    const trimmed = text.trim()
    if (!voiced()) return
    if (classifying()) return

    if (store.editing) {
      if (multi()) {
        const prev = store.custom[store.tab]
        const inputs = [...store.custom]
        inputs[store.tab] = text
        setStore("custom", inputs)
        const existing = store.answers[store.tab] ?? []
        const next = [...existing]
        if (prev) {
          const idx = next.indexOf(prev)
          if (idx !== -1) next.splice(idx, 1)
        }
        if (!next.includes(text)) next.push(text)
        const answers = [...store.answers]
        answers[store.tab] = next
        setStore("answers", answers)
        setStore("editing", false)
      } else {
        pick(text, true)
        setStore("editing", false)
      }
      return
    }

    const labels = options().map((o) => o.label)
    if (labels.length === 0) {
      if (!trimmed) return
      setVoiceTrace({ transcript: trimmed, matched: "Custom", confidence: null })
      pick(trimmed, true)
      return
    }

    if (!trimmed) return

    const model = local.model.current()
    if (!model || !sdk.classify) {
      setVoiceTrace({ transcript: trimmed, matched: "Custom (no model)", confidence: null })
      pick(trimmed, true)
      return
    }

    setClassifying(true)
    try {
      const result = await sdk.classify({
        providerID: model.providerID,
        modelID: model.modelID,
        transcript: text,
        options: labels,
        question: question()?.question,
      })
      setClassifying(false)
      if (!voiced()) return

      const conf = typeof result.confidence === "number" ? result.confidence : null
      const ok = Boolean(result.option && result.confidence !== 0 && labels.includes(result.option))

      if (ok) {
        setVoiceTrace({ transcript: trimmed, matched: result.option!, confidence: conf })
        if (multi()) toggle(result.option!)
        else pick(result.option!)
        return
      }

      setVoiceTrace({ transcript: trimmed, matched: "Custom (no match)", confidence: conf })
      pick(trimmed, true)
    } catch (err) {
      setClassifying(false)
      if (!voiced()) return
      setVoiceTrace({ transcript: trimmed, matched: "Custom (error)", confidence: null })
      pick(trimmed, true)
      toast.show({
        variant: "error",
        title: "Classification failed",
        message: err instanceof Error ? err.message : "An unknown error occurred",
        duration: 5000,
      })
    }
  }

  const voice = useVoice({ onResult: handleVoiceResult, color: theme.warning })

  createEffect(() => {
    if (voice.recording()) setVoiceTrace(null)
  })

  createEffect(() => {
    const n = questions().length
    if (!voiced() || n === 0) return
    if (store.tab >= n) {
      setStore("tab", n - 1)
    }
  })

  useKeyboard((evt) => {
    if (dialog.stack.length > 0) return

    if (voiced()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        if (voice.recording()) {
          voice.cancel()
          return
        }
        if (store.editing) {
          setStore("editing", false)
          return
        }
        reject()
        return
      }
      if (evt.name === "space") {
        evt.preventDefault()
        if (classifying()) return
        voice.toggle()
        return
      }
      if (!store.editing && evt.name === "return" && evt.shift && multi() && last()) {
        evt.preventDefault()
        if ((store.answers[store.tab] ?? []).length > 0) submit()
        return
      }
    }

    // When editing custom answer textarea
    if (store.editing && !confirm()) {
      if (evt.name === "escape") {
        evt.preventDefault()
        setStore("editing", false)
        return
      }
      if (keybind.match("input_clear", evt)) {
        evt.preventDefault()
        const text = textarea?.plainText ?? ""
        if (!text) {
          setStore("editing", false)
          return
        }
        textarea?.setText("")
        return
      }
      if (evt.name === "return") {
        evt.preventDefault()
        const text = textarea?.plainText?.trim() ?? ""
        const prev = store.custom[store.tab]

        if (!text) {
          if (prev) {
            const inputs = [...store.custom]
            inputs[store.tab] = ""
            setStore("custom", inputs)

            const answers = [...store.answers]
            answers[store.tab] = (answers[store.tab] ?? []).filter((x) => x !== prev)
            setStore("answers", answers)
          }
          setStore("editing", false)
          return
        }

        if (multi()) {
          const inputs = [...store.custom]
          inputs[store.tab] = text
          setStore("custom", inputs)

          const existing = store.answers[store.tab] ?? []
          const next = [...existing]
          if (prev) {
            const index = next.indexOf(prev)
            if (index !== -1) next.splice(index, 1)
          }
          if (!next.includes(text)) next.push(text)
          const answers = [...store.answers]
          answers[store.tab] = next
          setStore("answers", answers)
          setStore("editing", false)
          return
        }

        pick(text, true)
        setStore("editing", false)
        return
      }
      return
    }

    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      selectTab((store.tab - 1 + tabs()) % tabs())
    }

    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      selectTab((store.tab + 1) % tabs())
    }

    if (evt.name === "tab") {
      evt.preventDefault()
      const direction = evt.shift ? -1 : 1
      selectTab((store.tab + direction + tabs()) % tabs())
    }

    if (confirm() && !voiced()) {
      if (evt.name === "return") {
        evt.preventDefault()
        submit()
      }
      if (evt.name === "escape" || keybind.match("app_exit", evt)) {
        evt.preventDefault()
        reject()
      }
      return
    }

    const opts = options()
    const total = opts.length + (custom() ? 1 : 0)
    const max = Math.min(total, 9)
    const digit = Number(evt.name)

    if (!Number.isNaN(digit) && digit >= 1 && digit <= max) {
      evt.preventDefault()
      const index = digit - 1
      moveTo(index)
      selectOption()
      return
    }

    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      moveTo((store.selected - 1 + total) % total)
    }

    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      moveTo((store.selected + 1) % total)
    }

    if (evt.name === "return") {
      evt.preventDefault()
      selectOption()
    }

    if (evt.name === "escape" || keybind.match("app_exit", evt)) {
      evt.preventDefault()
      reject()
    }
  })

  return (
    <box
      backgroundColor={theme.backgroundPanel}
      border={["left"]}
      borderColor={theme.accent}
      customBorderChars={SplitBorder.customBorderChars}
    >
      <box gap={1} paddingLeft={1} paddingRight={3} paddingTop={1} paddingBottom={1}>
        <Show when={!single()}>
          <box flexDirection="row" gap={1} paddingLeft={1}>
            <For each={questions()}>
              {(q, index) => {
                const isActive = () => index() === store.tab
                const isAnswered = () => {
                  return (store.answers[index()]?.length ?? 0) > 0
                }
                return (
                  <box
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={
                      isActive()
                        ? theme.accent
                        : tabHover() === index()
                          ? theme.backgroundElement
                          : theme.backgroundPanel
                    }
                    onMouseOver={() => setTabHover(index())}
                    onMouseOut={() => setTabHover(null)}
                    onMouseUp={() => selectTab(index())}
                  >
                    <text
                      fg={
                        isActive()
                          ? selectedForeground(theme, theme.accent)
                          : isAnswered()
                            ? theme.text
                            : theme.textMuted
                      }
                    >
                      {q.header}
                    </text>
                  </box>
                )
              }}
            </For>
            <Show when={!voiced()}>
              <box
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={
                  confirm() ? theme.accent : tabHover() === "confirm" ? theme.backgroundElement : theme.backgroundPanel
                }
                onMouseOver={() => setTabHover("confirm")}
                onMouseOut={() => setTabHover(null)}
                onMouseUp={() => selectTab(questions().length)}
              >
                <text fg={confirm() ? selectedForeground(theme, theme.accent) : theme.textMuted}>Confirm</text>
              </box>
            </Show>
          </box>
        </Show>

        <Show when={!confirm()}>
          <box paddingLeft={1} gap={1}>
            <box>
              <text fg={theme.text}>
                {question()?.question}
                {multi() ? " (select all that apply)" : ""}
              </text>
            </box>
            <Show when={voiced() && classifying()}>
              <box paddingLeft={1}>
                <text fg={theme.textMuted}>Processing...</text>
              </box>
            </Show>
            <Show when={voiced() && !classifying() && !store.editing && (voice.recording() || voice.transcribing())}>
              <box paddingLeft={1}>
                <text content={voice.placeholder()} />
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
                    <span style={{ fg: theme.textMuted }}> · {Math.round((voiceTrace()!.confidence ?? 0) * 100)}%</span>
                  </Show>
                </text>
              </box>
            </Show>
            <box>
              <For each={options()}>
                {(opt, i) => {
                  const active = () => i() === store.selected
                  const picked = () => store.answers[store.tab]?.includes(opt.label) ?? false
                  return (
                    <box
                      onMouseOver={() => moveTo(i())}
                      onMouseDown={() => moveTo(i())}
                      onMouseUp={() => selectOption()}
                    >
                      <box flexDirection="row">
                        <box backgroundColor={active() ? theme.backgroundElement : undefined} paddingRight={1}>
                          <text fg={active() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                            {`${i() + 1}.`}
                          </text>
                        </box>
                        <box backgroundColor={active() ? theme.backgroundElement : undefined}>
                          <text fg={active() ? theme.secondary : picked() ? theme.success : theme.text}>
                            {multi() ? `[${picked() ? "✓" : " "}] ${opt.label}` : opt.label}
                          </text>
                        </box>
                        <Show when={!multi()}>
                          <text fg={theme.success}>{picked() ? "✓" : ""}</text>
                        </Show>
                      </box>

                      <box paddingLeft={3}>
                        <text fg={theme.textMuted}>{opt.description}</text>
                      </box>
                    </box>
                  )
                }}
              </For>
              <Show when={custom()}>
                <box
                  onMouseOver={() => moveTo(options().length)}
                  onMouseDown={() => moveTo(options().length)}
                  onMouseUp={() => selectOption()}
                >
                  <box flexDirection="row">
                    <box backgroundColor={other() ? theme.backgroundElement : undefined} paddingRight={1}>
                      <text fg={other() ? tint(theme.textMuted, theme.secondary, 0.6) : theme.textMuted}>
                        {`${options().length + 1}.`}
                      </text>
                    </box>
                    <box backgroundColor={other() ? theme.backgroundElement : undefined}>
                      <text fg={other() ? theme.secondary : customPicked() ? theme.success : theme.text}>
                        {multi() ? `[${customPicked() ? "✓" : " "}] Type your own answer` : "Type your own answer"}
                      </text>
                    </box>

                    <Show when={!multi()}>
                      <text fg={theme.success}>{customPicked() ? "✓" : ""}</text>
                    </Show>
                  </box>
                  <Show when={store.editing}>
                    <box paddingLeft={3}>
                      <Show when={voiced()}>
                        <text content={voice.placeholder()} />
                      </Show>
                      <Show when={!voiced()}>
                        <textarea
                          ref={(val: TextareaRenderable) => {
                            textarea = val
                            queueMicrotask(() => {
                              val.focus()
                              val.gotoLineEnd()
                            })
                          }}
                          initialValue={input()}
                          placeholder="Type your own answer"
                          minHeight={1}
                          maxHeight={6}
                          textColor={theme.text}
                          focusedTextColor={theme.text}
                          cursorColor={theme.primary}
                          keyBindings={bindings()}
                        />
                      </Show>
                    </box>
                  </Show>
                  <Show when={!store.editing && input()}>
                    <box paddingLeft={3}>
                      <text fg={theme.textMuted}>{input()}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          </box>
        </Show>

        <Show when={confirm() && !single()}>
          <box paddingLeft={1}>
            <text fg={theme.text}>Review</text>
          </box>
          <For each={questions()}>
            {(q, index) => {
              const value = () => store.answers[index()]?.join(", ") ?? ""
              const answered = () => Boolean(value())
              return (
                <box paddingLeft={1}>
                  <text>
                    <span style={{ fg: theme.textMuted }}>{q.header}:</span>{" "}
                    <span style={{ fg: answered() ? theme.text : theme.error }}>
                      {answered() ? value() : "(not answered)"}
                    </span>
                  </text>
                </box>
              )
            }}
          </For>
        </Show>
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        gap={1}
        paddingLeft={2}
        paddingRight={3}
        paddingBottom={1}
        justifyContent="space-between"
      >
        <box flexDirection="row" gap={2}>
          <Show when={voiced()}>
            <text fg={theme.text}>
              space <span style={{ fg: theme.textMuted }}>{voice.recording() ? "stop" : "record"}</span>
            </text>
          </Show>
          <Show when={!single()}>
            <text fg={theme.text}>
              {"⇆"} <span style={{ fg: theme.textMuted }}>tab</span>
            </text>
          </Show>
          <Show when={!confirm()}>
            <text fg={theme.text}>
              {"↑↓"} <span style={{ fg: theme.textMuted }}>select</span>
            </text>
          </Show>
          <Show when={voiced() && multi() && last()}>
            <text fg={theme.text}>
              shift+enter <span style={{ fg: theme.textMuted }}>submit</span>
            </text>
          </Show>
          <text fg={theme.text}>
            enter{" "}
            <span style={{ fg: theme.textMuted }}>
              {confirm() ? "submit" : multi() ? "toggle" : single() ? "submit" : "confirm"}
            </span>
          </text>

          <text fg={theme.text}>
            esc <span style={{ fg: theme.textMuted }}>dismiss</span>
          </text>
        </box>
      </box>
    </box>
  )
}
