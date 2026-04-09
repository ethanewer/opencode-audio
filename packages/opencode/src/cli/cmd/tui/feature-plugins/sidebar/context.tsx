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

  // Cumulative token totals from all step-finish parts (persists through compaction)
  const totals = createMemo(() => {
    let input = 0
    let output = 0
    let cached = 0
    for (const m of msg()) {
      if (m.role !== "assistant") continue
      const parts = props.api.state.part(m.id)
      for (const p of parts) {
        if (p.type !== "step-finish") continue
        const step = p as StepFinishPart
        input += step.tokens.input + step.tokens.cache.read + step.tokens.cache.write
        output += step.tokens.output
        cached += step.tokens.cache.read
      }
    }
    return { input, output, cached }
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
        {Locale.number(context().tokens)} tokens{context().percent != null ? ` (${context().percent}%)` : ""}
      </text>
      <text fg={theme().textMuted}>
        In {Locale.number(totals().input)} · Out {Locale.number(totals().output)} · Cache {Locale.number(totals().cached)}
      </text>
      <text fg={theme().textMuted}>
        {money.format(cost())} spent
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
