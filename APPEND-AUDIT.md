# Slash Append Feature Audit

## Feature Overview

The `/append` command toggles between two message queueing modes:

1. **Append while working** (append mode OFF): Messages submitted while the agent is working are sent immediately to the server. The agent sees them on its next LLM iteration. In-flight work is not interrupted.

2. **Append after working** (append mode ON): Messages submitted while the agent is working are held in a client-side deferred queue. They are only dispatched to the server after the agent fully completes its current work (session status idle, auto phase idle, no pending permissions/questions).

Both modes queue messages. The key difference is **when queued messages are admitted into model context**.

## Architecture

The append feature spans these layers:

| Layer | File | Responsibility |
|-------|------|----------------|
| Session route | `src/cli/cmd/tui/routes/session/index.tsx` | State signals (`appendMode`, `deferred`, `sending`, `shouldDefer`), dispatch effect, command registration |
| Prompt component | `src/cli/cmd/tui/component/prompt/index.tsx` | Draft construction, defer check on submit, `dispatchDraft()`, voice audio submission, deferred queue UI |
| Event system | `src/cli/cmd/tui/event.ts` | `TuiEvent.PromptAppend` for external prompt appending |
| Server routes | `src/server/routes/tui.ts` | `/append-prompt` HTTP endpoint, `/execute-command` |

The backend prompt/loop layer (`src/session/prompt.ts`, `src/session/llm.ts`) is unaware of append mode — it processes messages as they arrive.

## What Was Audited

### 1. Basic append-mode semantics
- `shouldDefer` predicate logic
- Reactive dispatch effect conditions
- `sending` flag lifecycle
- Mode toggling

### 2. Slash actions in the queue
- `/eval` deferral path
- Command-type draft construction and dispatch

### 3. Voice message behavior
- Transcription-based voice submission path
- Direct audio input submission path
- `returnToVoice` state transitions

### 4. Multiple queued messages
- Queue ordering guarantees
- Sequential dispatch via `sending` flag
- Race conditions between queue drain and new submissions

### 5. Mode and agent changes before submission
- Agent/model capture at defer time vs dispatch time
- Auto mode permission handling in `dispatchDraft`

### 6. UX edge cases
- Toast message accuracy
- Session navigation cleanup
- Queue bypass race conditions

## Findings

### Already Correct

- **Transcription-based voice messages** properly go through `submit()` → `shouldDefer()` check. Append mode is respected.
- **Queue ordering** is maintained by appending to the deferred array and always dispatching `deferred()[0]`.
- **Session navigation** correctly clears the deferred queue and resets `sending`.
- **Auto mode orchestration** (plan → build → eval) correctly integrates with the deferred dispatch effect.
- **Permission/question gating** — deferred dispatch waits for pending permissions and questions to clear.
- **`sending` flag lifecycle** — set on dispatch start, cleared when agent transitions to busy, prevents concurrent dispatches.
- **Command dispatch** (`/eval`, shell commands) routes through `dispatchDraft` correctly.

### Issues Found and Fixed

#### Issue 1: Queue bypass race condition in `shouldDefer`

**Problem:** When append mode was on and the agent became idle with deferred messages waiting, there was a race window where a new user message could bypass the queue. `shouldDefer` only checked session status and auto phase — not whether the queue had pending items or whether a dispatch was in progress.

**Scenario:**
1. Agent finishes → status idle
2. Dispatch effect fires → `send(item)` → `sending=true`
3. User submits new message before status changes to busy
4. `shouldDefer` returns false (status idle, phase idle) → new message sent immediately, cutting ahead of queued messages

**Fix:** Added `sending()` and `deferred().length > 0` checks to `shouldDefer`:
```typescript
const shouldDefer = createMemo(() => {
  if (!appendMode()) return false
  if (sending()) return true          // dispatch in progress
  if (deferred().length > 0) return true  // queue not empty
  if (local.agent.auto.phase() !== "idle") return true
  return status().type !== "idle"
})
```

**File:** `src/cli/cmd/tui/routes/session/index.tsx:231-237`

#### Issue 2: Direct audio input bypassed append mode

**Problem:** The `onAudio` callback in the prompt component submitted voice audio directly to the server via `sdk.client.session.prompt()` without checking `shouldDefer()`. This meant audio input in voice mode completely ignored append mode.

**Fix:** Added `shouldDefer()` check at the top of `onAudio`. When deferring, creates a `DeferredDraft` with the audio file part and `"[voice audio input]"` text, then calls `onDefer()`.

**File:** `src/cli/cmd/tui/component/prompt/index.tsx:346-402`

#### Issue 3: Toast count off by one

**Problem:** Both toast messages showed `deferred().length + 1` after calling `setDeferred()`. In Solid.js, signal updates are synchronous in untracked contexts (event handlers), so `deferred().length` already reflects the new item. The `+1` overcounted by one.

**Fix:** Changed both toast messages to use `deferred().length` without `+1`.

**Files:**
- `src/cli/cmd/tui/routes/session/index.tsx:641` (eval deferral toast)
- `src/cli/cmd/tui/routes/session/index.tsx:1456` (onDefer callback toast)

#### Issue 4: Deferred messages dispatched with stale agent/model

**Problem:** When a message was deferred, it captured the agent and model at defer time. When dispatched later, it used those stale values. Per the product requirement, queue behavior should respect the user's currently selected mode and agent at the time the message is actually started.

**Scenario:** User defers a message while in "plan" agent with model A. Before the message dispatches, user switches to "auto" agent with model B. The deferred message would incorrectly use "plan"/model A.

**Fix:** In the `send()` function, override the draft's agent, model, and variant with the current selections before calling `dispatchDraft()`:
```typescript
const currentAgent = local.agent.current()?.name ?? "build"
const currentModel = local.model.current()
const currentVariant = local.model.variant.current()
await dispatchDraft({
  sdk, local,
  draft: {
    ...item,
    agent: currentAgent,
    ...(currentModel ? { model: { ... } } : {}),
    variant: currentVariant,
    sessionID,
  },
})
```

**File:** `src/cli/cmd/tui/routes/session/index.tsx:392-423`

#### Issue 5: Eval deferral missing variant

**Problem:** The eval command's deferred draft didn't include the `variant` field, so deferred `/eval` commands would lose the user's variant selection.

**Fix:** Added `variant: local.model.variant.current()` to the eval deferral draft.

**File:** `src/cli/cmd/tui/routes/session/index.tsx:638`

## Verification

### Unit Tests

Added `test/session/append-defer.test.ts` with 25 tests covering:

- **shouldDefer predicate** (7 tests): All combinations of appendMode, sending, deferredCount, autoPhase, statusType
- **DeferredDraft construction** (4 tests): Normal, command, voice audio, and shell drafts
- **Queue ordering** (2 tests): Insertion order and dispatch-then-remaining order
- **Agent/model override** (2 tests): Current overrides deferred; fallback when no current model
- **Toast count accuracy** (2 tests): Correct count vs old off-by-one
- **Dispatch effect conditions** (8 tests): All gating conditions (sessionID, status, phase, sending, permissions, questions, queue emptiness)

### Existing Tests

All 32 existing `prompt-effect.test.ts` tests continue to pass, confirming no regressions in the backend prompt/loop layer.

### Type Check

Zero type errors in `tsc --noEmit` for the entire opencode package.

## Remaining Risks and Follow-ups

1. **No way to cancel deferred messages.** Users can toggle append mode off to stop deferring new messages, but cannot clear the existing queue. Consider adding a "Clear deferred queue" command.

2. **`sending` flag stuck if server never starts processing.** If `dispatchDraft` succeeds (HTTP 200) but the server never transitions session status to busy, `sending` stays true indefinitely, blocking further queue dispatch. This is a server-level edge case, not an append bug, but a timeout safety net could help.

3. **Append mode persists across session navigation.** This is intentional — it's a user preference, not session-specific state. The deferred queue IS cleared on navigation. Documented as expected behavior.

4. **Audio deferral stores base64 data in memory.** Deferred audio messages hold the full base64-encoded WAV data in the queue array. For very long recordings or many deferred audio messages, this could consume significant memory. Consider storing audio to a temp file and referencing by path instead.

5. **No E2E/integration tests for TUI reactive behavior.** The append logic is deeply intertwined with Solid.js signals. Full integration testing would require a TUI test harness that can simulate signal state transitions. The unit tests cover the logical invariants but not the reactive wiring.
