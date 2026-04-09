import type { AssistantMessage, StepFinishPart } from "@opencode-ai/sdk/v2"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createMemo } from "solid-js"
import { Locale } from "@/util/locale"

const id = "internal:sidebar-context"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

function View(props: { api: TuiPluginApi; session_id: string }) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const cost = createMemo(() => msg().reduce((sum, item) => sum + (item.role === "assistant" ? item.cost : 0), 0))

  // Cumulative cache stats from all step-finish parts (persists through compaction)
  // tokens.input is adjusted (total - cache.read - cache.write), so
  // total input = tokens.input + cache.read + cache.write (reconstructs raw inputTokens)
  const cache = createMemo(() => {
    let totalInput = 0
    let cacheRead = 0
    for (const m of msg()) {
      if (m.role !== "assistant") continue
      const parts = props.api.state.part(m.id)
      for (const p of parts) {
        if (p.type !== "step-finish") continue
        const step = p as StepFinishPart
        totalInput += step.tokens.input + step.tokens.cache.read + step.tokens.cache.write
        cacheRead += step.tokens.cache.read
      }
    }
    return totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : null
  })

  // Current context length from the last assistant message (resets on compaction)
  const context = createMemo(() => {
    const last = msg().findLast((item): item is AssistantMessage => item.role === "assistant" && item.tokens.output > 0)
    if (!last) return { tokens: 0, percent: null }
    const tokens =
      last.tokens.input + last.tokens.output + last.tokens.reasoning + last.tokens.cache.read + last.tokens.cache.write
    const model = props.api.state.provider.find((item) => item.id === last.providerID)?.models[last.modelID]
    return {
      tokens,
      percent: model?.limit.context ? Math.round((tokens / model.limit.context) * 100) : null,
    }
  })

  return (
    <box>
      <text fg={theme().text}>
        <b>Context</b>
      </text>
      <text fg={theme().textMuted}>
        {Locale.number(context().tokens)} tokens ({context().percent ?? 0}%)
      </text>
      <text fg={theme().textMuted}>
        {cache() ?? 0}% cached · {money.format(cost())} spent
      </text>
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
