import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import * as AudioCost from "@/audio/cost"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const textCost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))
  const [revision, setRevision] = createSignal(0)
  onCleanup(AudioCost.subscribe(() => setRevision((n) => n + 1)))
  const audio = createMemo(() => {
    revision()
    return AudioCost.get(props.session_id)
  })

  const state = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) {
      return {
        tokens: 0,
        percent: null,
      }
    }

    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  const hasAudio = createMemo(() => audio().input > 0 || audio().output > 0)
  const total = createMemo(() => textCost() + audio().input + audio().output)

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>
        {state().tokens.toLocaleString()} tokens · {state().percent ?? 0}%
      </text>
      <Show when={hasAudio()} fallback={<text fg={theme().textMuted}>{money.format(textCost())} spent</text>}>
        <text fg={theme().textMuted}>
          {audio().input > 0 ? `in ${money.format(audio().input)} · ` : ""}text {money.format(textCost())}
          {audio().output > 0 ? ` · out ${money.format(audio().output)}` : ""}
        </text>
        <text fg={theme().textMuted}>Total {money.format(total())}</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} session_id={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
