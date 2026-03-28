# Interactive Voice Agent Plan

## Goal

Make the voice agent feel more interactive via two features:

1. **Live status narration** — Short spoken status updates as the agent works (tool starts, tool completions), never building up a queue that falls behind.
2. **Streaming TTS for final output** — Start speaking the agent's text response as it streams in, rather than waiting for the full response to complete.

---

## Current Architecture Summary

- **SpeechQueue** (`src/audio/speech-queue.ts`) already supports incremental `push()` with sentence-splitting (≥40 chars) and eager TTS prefetch. But `useSpeech` only feeds it in one batch after the session goes idle.
- **speak.ts** uses `experimental_generateSpeech` from the Vercel AI SDK → OpenAI TTS API. Returns complete WAV audio (no streaming).
- **Event system**: Tool lifecycle publishes `message.part.updated` (SyncEvent) with ToolPart state transitions: `pending → running → completed/error`. Text deltas publish `message.part.delta` (BusEvent, transient).
- **TUI sync store** receives all events reactively. `useSpeech` subscribes to `session.status`, `permission.asked`, and `question.asked` via `sdk.event.on(...)`.

---

## Feature 1: Live Status Narration During Tool Execution

### Design

When the model produces text output in a step that also contains tool calls, that text is a natural status message from the agent describing what it's doing. These "interstitial" text parts should be spoken aloud as status updates. To avoid building up a queue that falls behind the agent, use a **drop-if-busy** approach: if a new status text arrives while one is still being generated or played, simply discard it.

### How to Distinguish Status Text from Final Output

A model step can contain a mix of text parts and tool parts. The key distinction:

- **Status text**: A text part in a step that also contains tool calls. The model is narrating its work while invoking tools.
- **Final output text**: A text part in the last step of the response, when the session goes idle and no more tool calls follow. This is the actual response to speak via streaming TTS (Feature 2).

In practice, the simplest approach: accumulate text deltas into the StatusSpeaker during a step. When a `step-finish` event arrives, check whether that step had any tool calls. If it did, the accumulated text was a status message — speak it via the StatusSpeaker (drop-if-busy). If the step had no tool calls, the text is final output — it will already be handled by the streaming TTS (Feature 2). Alternatively, since Feature 2 subscribes to deltas directly and the SpeechQueue accumulates text until sentence boundaries, we can use a simpler heuristic: when `session.status` becomes `idle`, the SpeechQueue flushes its remaining buffer as final output. During busy execution, text that arrives interleaved with tool calls gets routed to the StatusSpeaker instead.

**Chosen approach**: Track whether the current step has tool calls. Text in a step with tools goes to StatusSpeaker. Text in a step without tools goes to the streaming SpeechQueue. This is determined reactively: when a `tool-input-start` or `tool-call` part appears for the current assistant message, mark the step as "has tools." On `step-finish`, reset. Text deltas route accordingly.

### Key Constraint: Never Queue Behind

The StatusSpeaker uses a **drop-if-busy** model. It tracks whether it is currently generating or playing audio. New status updates are silently dropped when it is busy. The user hears periodic updates when the system has bandwidth, and rapid steps are naturally thinned out.

### Implementation

#### 1a. Add a `StatusSpeaker` utility

Create a new file `src/audio/status-speaker.ts` with a class that:

- Holds a single in-flight TTS request + playback handle.
- Tracks a `busy` flag.
- On `speak(text)`: if busy, drop the text and return. Otherwise, set busy=true, fire TTS request, play audio, then set busy=false.
- On `cancel()`: cancels any in-flight TTS/playback and resets busy to false.
- Uses the same `SpeakFn` and config as the main queue.

```
class StatusSpeaker {
  private busy = false
  private current: { abort: AbortController; player?: ReturnType<typeof play> } | null
  private speakFn: SpeakFn

  speak(text: string): void   // fire-and-forget, drops if busy
  cancel(): void
}
```

#### 1b. Track step context and route text in `useSpeech`

In `src/cli/cmd/tui/util/speech.ts`:

- Maintain a `stepHasTools` boolean flag, initially false.
- Maintain a `statusBuffer` string that accumulates text deltas during tool-bearing steps.

Subscribe to `message.part.updated`:

- When a tool part (`type === "tool"`) appears for the current voice-agent message, set `stepHasTools = true`.
- When a `step-finish` part appears: if `stepHasTools` is true and `statusBuffer` has content, call `statusSpeaker.speak(statusBuffer)`. Reset `stepHasTools = false` and `statusBuffer = ""`.

Subscribe to `message.part.delta`:

- If `stepHasTools` is true, append the delta to `statusBuffer` (for the StatusSpeaker).
- If `stepHasTools` is false, push the delta to the streaming SpeechQueue (Feature 2).

This cleanly separates status narration from final output streaming.

#### 1c. Cancel status speech when final output starts

When the session goes idle, cancel the StatusSpeaker so it doesn't overlap with the final streaming TTS flush.

#### 1d. Cleanup

Add event unsubscribers to the `onCleanup` handler and `statusSpeaker.cancel()`.

### Files to modify

- `src/audio/status-speaker.ts` (new) — single-slot, drop-if-busy status speaker
- `src/cli/cmd/tui/util/speech.ts` — track step context, route text to StatusSpeaker vs SpeechQueue

---

## Feature 2: Streaming TTS for Final Output

### Design

Instead of waiting for `session.status === "idle"` to speak all text at once, subscribe to `message.part.delta` events and feed text deltas into the `SpeechQueue` incrementally. The queue already handles sentence splitting and eager TTS prefetch — it just needs to be fed during streaming rather than after completion.

### Implementation

#### 2a. Subscribe to `message.part.delta` in `useSpeech`

Replace the current "speak on idle" approach for text output with streaming:

```typescript
const offDelta = sdk.event.on("message.part.delta", (evt) => {
  if (!enabled()) return
  if (evt.properties.field !== "text") return
  if (evt.properties.sessionID !== sessionID()) return

  // Verify this delta belongs to a voice agent's assistant message
  const messages = sync.data.message[sessionID()] ?? []
  const last = messages.findLast((m) => m.role === "assistant")
  if (!last || !VOICE_AGENTS.has(last.agent)) return
  if (evt.properties.messageID !== last.id) return

  // Cancel any status narration — the agent is now producing text output
  statusSpeaker.cancel()

  const q = getQueue()
  if (!q) return
  setSpeaking(true)
  q.push(evt.properties.delta)
})
```

#### 2b. Flush remaining text on session idle

Keep a slimmed-down `session.status` handler that calls `queue.flush()` when the session goes idle, to emit any remaining buffered text that didn't reach the 40-char sentence threshold:

```typescript
const offStatus = sdk.event.on("session.status", (evt) => {
  if (!enabled()) return
  if (evt.properties.sessionID !== sessionID()) return
  if (evt.properties.status.type !== "idle") return

  // Flush any remaining buffered text
  if (queue) {
    queue.flush()
  }
})
```

#### 2c. Cancel streaming speech on new user input

When the user sends a new message (starting a new turn), cancel the queue so old speech doesn't overlap:

This is already handled by the existing `cancel()` function exposed by `useSpeech`, which is called from the session route when the user submits input.

#### 2d. Handle multi-step responses

The agent may produce text, then call tools, then produce more text. When text streaming starts, cancel the status speaker. When tools start running again (no active text delta for a while), the status speaker can resume via the part-updated subscription.

The `SpeechQueue.push()` + `flush()` model handles this naturally: text deltas feed the queue incrementally, and when the agent switches to tools, no more deltas arrive, so the queue drains its current buffer.

### Files to modify

- `src/cli/cmd/tui/util/speech.ts` — replace idle-batch with streaming delta subscription

---

## Implementation Order

1. Create `StatusSpeaker` class (`src/audio/status-speaker.ts`)
2. Add step-context tracking (`stepHasTools` flag, `statusBuffer`) in `useSpeech`
3. Add `message.part.updated` subscription to detect tool parts and step-finish events
4. Add `message.part.delta` subscription that routes text to StatusSpeaker (tool steps) or SpeechQueue (non-tool steps)
5. Modify `session.status` handler to just flush the SpeechQueue (no longer batch-push all text)
6. Wire cleanup for new subscriptions
7. Test manually with a voice agent session

---

## Feature 3: Reduce Status Text Verbosity

### Problem

The voice prompt (`voice.txt`) currently **replaces** the provider-specific system prompt entirely (via the `agent.prompt` field in `llm.ts` line 74). This means voice agents lose all the detailed behavioral instructions from `anthropic.txt`, `default.txt`, etc. — including instructions about conciseness, minimizing output, and avoiding preamble/postamble. Without these constraints, the model falls back to verbose narration between tool calls.

### Approach: Improved Prompts (not model-based filtering)

**Why not model-based filtering:**

- Adds 200-800ms latency per status update on top of the 200-500ms TTS latency
- The StatusSpeaker is drop-if-busy, so extra latency means fewer updates get through
- A filter model can only cut/compress text — it can't fix the root cause of bad output
- Zero-latency prompt improvements solve the problem at the source

**The fix has two parts:**

#### 3a. Append voice prompt instead of replacing provider prompt

Change the voice agent definitions so that `prompt` is not set on the agent. Instead, append the voice prompt instructions via a different mechanism so the provider prompt is preserved.

The cleanest approach: in `llm.ts` where the system prompt is assembled, detect voice agents and append `PROMPT_VOICE` after the provider prompt rather than replacing it. Alternatively, remove `prompt` from the voice agent definitions in `agent.ts` and instead append the voice instructions in `SessionPrompt` (in `prompt.ts`) when the agent is a voice agent.

Implementation: Remove the `prompt: PROMPT_VOICE` from voice-build and voice-plan in `agent.ts`. In `llm.ts`, add the voice prompt to `input.system` when the agent name starts with "voice-". This way the provider prompt is preserved and the voice instructions are appended.

#### 3b. Add status-specific instructions to voice prompt

Add explicit instructions to `voice.txt` about interstitial text during tool-bearing steps:

- When outputting text alongside tool calls, limit to a single short sentence describing what you're about to do.
- Skip narration entirely when the tool action is self-explanatory from context.
- Never repeat what a tool result already shows.
- Do not narrate each step of a multi-step task — only mention major milestones.

### Files to modify

- `src/agent/agent.ts` — remove `prompt: PROMPT_VOICE` from voice-build and voice-plan
- `src/session/llm.ts` — append voice prompt for voice agents without replacing provider prompt
- `src/agent/prompt/voice.txt` — add status text instructions

---

## Risks and Mitigations

- **TTS latency**: OpenAI TTS takes ~300-800ms per request. The SpeechQueue's prefetch pipeline mitigates this — while one sentence plays, the next is already being generated.
- **Rapid steps with status text**: The drop-if-busy StatusSpeaker design ensures updates are silently discarded when the system can't keep up, so speech never falls behind the agent's work.
- **Status overlapping with text output**: Cancelling the StatusSpeaker when text deltas start prevents overlap.
- **Short text fragments**: The SpeechQueue's 40-char minimum accumulation prevents sending tiny fragments to TTS, which would sound choppy.
- **16ms event batching in SDK**: Text deltas are batched at 16ms intervals, which means multiple deltas may arrive together. This is fine — `push()` accumulates them in the buffer and `drainBuffer` only emits when a sentence boundary + 40 chars is reached.
