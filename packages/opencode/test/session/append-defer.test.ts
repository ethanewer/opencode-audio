import { describe, expect, test } from "bun:test"
import type { DeferredDraft } from "../../src/cli/cmd/tui/component/prompt/index"

/**
 * Tests for the append/defer feature logic.
 *
 * The append feature operates at the TUI layer using Solid.js signals.
 * These tests validate the core logical invariants independent of Solid.js
 * reactivity, focusing on:
 *
 * 1. shouldDefer predicate semantics
 * 2. DeferredDraft construction and shape
 * 3. Queue ordering guarantees
 * 4. Agent/model override at dispatch time
 */

// ── shouldDefer predicate logic ───────────────────────────────────

/**
 * Pure reimplementation of the shouldDefer predicate.
 * This mirrors the logic in session/index.tsx so we can test it in isolation.
 */
function shouldDefer(opts: {
  appendMode: boolean
  sending: boolean
  deferredCount: number
  autoPhase: string
  statusType: string
}): boolean {
  if (!opts.appendMode) return false
  if (opts.sending) return true
  if (opts.deferredCount > 0) return true
  if (opts.autoPhase !== "idle") return true
  return opts.statusType !== "idle"
}

describe("shouldDefer predicate", () => {
  test("returns false when append mode is off regardless of other state", () => {
    expect(
      shouldDefer({
        appendMode: false,
        sending: false,
        deferredCount: 0,
        autoPhase: "build",
        statusType: "busy",
      }),
    ).toBe(false)
  })

  test("returns false when append mode is on and everything is idle with empty queue", () => {
    expect(
      shouldDefer({
        appendMode: true,
        sending: false,
        deferredCount: 0,
        autoPhase: "idle",
        statusType: "idle",
      }),
    ).toBe(false)
  })

  test("returns true when append mode is on and session is busy", () => {
    expect(
      shouldDefer({
        appendMode: true,
        sending: false,
        deferredCount: 0,
        autoPhase: "idle",
        statusType: "busy",
      }),
    ).toBe(true)
  })

  test("returns true when append mode is on and auto phase is not idle", () => {
    expect(
      shouldDefer({
        appendMode: true,
        sending: false,
        deferredCount: 0,
        autoPhase: "build",
        statusType: "idle",
      }),
    ).toBe(true)
  })

  test("returns true when sending is active (prevents queue bypass)", () => {
    expect(
      shouldDefer({
        appendMode: true,
        sending: true,
        deferredCount: 0,
        autoPhase: "idle",
        statusType: "idle",
      }),
    ).toBe(true)
  })

  test("returns true when deferred queue is non-empty (preserves ordering)", () => {
    expect(
      shouldDefer({
        appendMode: true,
        sending: false,
        deferredCount: 3,
        autoPhase: "idle",
        statusType: "idle",
      }),
    ).toBe(true)
  })

  test("returns true when both sending and queue non-empty", () => {
    expect(
      shouldDefer({
        appendMode: true,
        sending: true,
        deferredCount: 2,
        autoPhase: "idle",
        statusType: "idle",
      }),
    ).toBe(true)
  })
})

// ── DeferredDraft construction ────────────────────────────────────

describe("DeferredDraft construction", () => {
  test("normal text message has correct shape", () => {
    const draft: DeferredDraft = {
      id: "msg-1",
      sessionID: "session-1",
      input: "hello world",
      parts: [],
      type: "normal",
      model: { providerID: "test", modelID: "test-model" },
      agent: "build",
      variant: undefined,
    }
    expect(draft.type).toBe("normal")
    expect(draft.input).toBe("hello world")
    expect(draft.agent).toBe("build")
  })

  test("command draft (e.g. /eval) has correct shape", () => {
    const draft: DeferredDraft = {
      id: "msg-2",
      sessionID: "session-1",
      input: "",
      parts: [],
      type: "command",
      command: "eval",
      args: "",
      model: { providerID: "test", modelID: "test-model" },
      agent: "build",
      variant: "fast",
    }
    expect(draft.type).toBe("command")
    expect(draft.command).toBe("eval")
    expect(draft.variant).toBe("fast")
  })

  test("voice audio draft stores audio file part", () => {
    const audioUrl = "data:audio/wav;base64,AAAA"
    const draft: DeferredDraft = {
      id: "msg-3",
      sessionID: "session-1",
      input: "[voice audio input]",
      parts: [
        {
          type: "file" as const,
          mime: "audio/wav",
          url: audioUrl,
          filename: "recording.wav",
        },
      ],
      type: "normal",
      model: { providerID: "test", modelID: "test-model" },
      agent: "build",
    }
    expect(draft.input).toBe("[voice audio input]")
    expect(draft.parts).toHaveLength(1)
    expect(draft.parts[0]!.type).toBe("file")
    const filePart = draft.parts[0] as { type: "file"; mime: string; url: string; filename: string }
    expect(filePart.mime).toBe("audio/wav")
    expect(filePart.url).toBe(audioUrl)
  })

  test("shell draft has correct type", () => {
    const draft: DeferredDraft = {
      id: "msg-4",
      sessionID: "session-1",
      input: "ls -la",
      parts: [],
      type: "shell",
      model: { providerID: "test", modelID: "test-model" },
      agent: "build",
    }
    expect(draft.type).toBe("shell")
  })
})

// ── Queue ordering ────────────────────────────────────────────────

describe("deferred queue ordering", () => {
  test("multiple deferred messages maintain insertion order", () => {
    const queue: DeferredDraft[] = []

    // Simulate three sequential deferrals
    const drafts: DeferredDraft[] = [
      {
        id: "msg-1",
        input: "first",
        parts: [],
        type: "normal",
        model: { providerID: "test", modelID: "test-model" },
        agent: "build",
      },
      {
        id: "msg-2",
        input: "second",
        parts: [],
        type: "normal",
        model: { providerID: "test", modelID: "test-model" },
        agent: "build",
      },
      {
        id: "msg-3",
        input: "third",
        parts: [],
        type: "command",
        command: "eval",
        args: "",
        model: { providerID: "test", modelID: "test-model" },
        agent: "auto",
      },
    ]

    for (const draft of drafts) {
      queue.push(draft)
    }

    expect(queue).toHaveLength(3)
    expect(queue[0]!.input).toBe("first")
    expect(queue[1]!.input).toBe("second")
    expect(queue[2]!.type).toBe("command")
  })

  test("dispatching first item preserves remaining order", () => {
    const queue: DeferredDraft[] = [
      { id: "1", input: "a", parts: [], type: "normal", model: { providerID: "t", modelID: "m" }, agent: "build" },
      { id: "2", input: "b", parts: [], type: "normal", model: { providerID: "t", modelID: "m" }, agent: "build" },
      { id: "3", input: "c", parts: [], type: "normal", model: { providerID: "t", modelID: "m" }, agent: "build" },
    ]

    // Simulate dispatching first item (as done in send())
    const dispatched = queue[0]!
    const remaining = queue.filter((x) => x.id !== dispatched.id)

    expect(remaining).toHaveLength(2)
    expect(remaining[0]!.input).toBe("b")
    expect(remaining[1]!.input).toBe("c")
  })
})

// ── Agent/model override at dispatch time ─────────────────────────

describe("agent and model override at dispatch time", () => {
  test("current agent overrides deferred agent", () => {
    const deferredItem: DeferredDraft = {
      id: "msg-1",
      sessionID: "session-1",
      input: "test",
      parts: [],
      type: "normal",
      model: { providerID: "old-provider", modelID: "old-model" },
      agent: "plan",
    }

    // Simulate what send() does: override with current selections
    const currentAgent = "auto"
    const currentModel = { providerID: "new-provider", modelID: "new-model" }
    const currentVariant = "fast"

    const dispatched = {
      ...deferredItem,
      agent: currentAgent,
      model: currentModel,
      variant: currentVariant,
      sessionID: deferredItem.sessionID!,
    }

    expect(dispatched.agent).toBe("auto")
    expect(dispatched.model.providerID).toBe("new-provider")
    expect(dispatched.model.modelID).toBe("new-model")
    expect(dispatched.variant).toBe("fast")
  })

  test("deferred model preserved when no current model available", () => {
    const deferredItem: DeferredDraft = {
      id: "msg-1",
      sessionID: "session-1",
      input: "test",
      parts: [],
      type: "normal",
      model: { providerID: "old-provider", modelID: "old-model" },
      agent: "build",
    }

    // Simulate send() when currentModel is undefined (no model selected)
    const currentAgent = "build"
    const currentVariant = undefined

    // When no current model, the spread is empty and deferred model is preserved
    function buildDispatchDraft(
      item: DeferredDraft,
      agent: string,
      model: { providerID: string; modelID: string } | undefined,
      variant: string | undefined,
    ) {
      return {
        ...item,
        agent,
        ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
        variant,
        sessionID: item.sessionID!,
      }
    }

    const dispatched = buildDispatchDraft(deferredItem, currentAgent, undefined, currentVariant)

    // When no current model, deferred model is preserved
    expect(dispatched.model.providerID).toBe("old-provider")
    expect(dispatched.model.modelID).toBe("old-model")
  })
})

// ── Toast message accuracy ────────────────────────────────────────

describe("deferred toast count", () => {
  test("toast shows correct count after adding to queue", () => {
    // Simulate Solid.js signal: setDeferred adds item, then deferred() reflects new length
    let queue: DeferredDraft[] = []

    // Add first item
    queue = [
      ...queue,
      { id: "1", input: "a", parts: [], type: "normal", model: { providerID: "t", modelID: "m" }, agent: "build" },
    ]
    // After setDeferred, queue.length already includes new item
    const toastMessage1 = `Message deferred (${queue.length} pending)`
    expect(toastMessage1).toBe("Message deferred (1 pending)")

    // Add second item
    queue = [
      ...queue,
      { id: "2", input: "b", parts: [], type: "normal", model: { providerID: "t", modelID: "m" }, agent: "build" },
    ]
    const toastMessage2 = `Message deferred (${queue.length} pending)`
    expect(toastMessage2).toBe("Message deferred (2 pending)")
  })

  test("old off-by-one toast would show wrong count", () => {
    let queue: DeferredDraft[] = []
    queue = [
      ...queue,
      { id: "1", input: "a", parts: [], type: "normal", model: { providerID: "t", modelID: "m" }, agent: "build" },
    ]
    // The old code used queue.length + 1 which is wrong after setDeferred
    const wrongToast = `Message deferred (${queue.length + 1} pending)`
    expect(wrongToast).toBe("Message deferred (2 pending)") // Wrong! Should be 1
  })
})

// ── Dispatch effect conditions ────────────────────────────────────

describe("dispatch effect conditions", () => {
  function canDispatch(opts: {
    sessionID: string | undefined
    statusType: string
    autoPhase: string
    sending: boolean
    permissionsCount: number
    questionsCount: number
    deferredCount: number
  }): boolean {
    if (!opts.sessionID) return false
    if (opts.statusType !== "idle") return false
    if (opts.autoPhase !== "idle") return false
    if (opts.sending) return false
    if (opts.permissionsCount > 0 || opts.questionsCount > 0) return false
    if (opts.deferredCount === 0) return false
    return true
  }

  test("dispatches when all conditions met", () => {
    expect(
      canDispatch({
        sessionID: "session-1",
        statusType: "idle",
        autoPhase: "idle",
        sending: false,
        permissionsCount: 0,
        questionsCount: 0,
        deferredCount: 1,
      }),
    ).toBe(true)
  })

  test("does not dispatch without session", () => {
    expect(
      canDispatch({
        sessionID: undefined,
        statusType: "idle",
        autoPhase: "idle",
        sending: false,
        permissionsCount: 0,
        questionsCount: 0,
        deferredCount: 1,
      }),
    ).toBe(false)
  })

  test("does not dispatch when busy", () => {
    expect(
      canDispatch({
        sessionID: "session-1",
        statusType: "busy",
        autoPhase: "idle",
        sending: false,
        permissionsCount: 0,
        questionsCount: 0,
        deferredCount: 1,
      }),
    ).toBe(false)
  })

  test("does not dispatch when auto phase not idle", () => {
    expect(
      canDispatch({
        sessionID: "session-1",
        statusType: "idle",
        autoPhase: "build",
        sending: false,
        permissionsCount: 0,
        questionsCount: 0,
        deferredCount: 1,
      }),
    ).toBe(false)
  })

  test("does not dispatch when already sending", () => {
    expect(
      canDispatch({
        sessionID: "session-1",
        statusType: "idle",
        autoPhase: "idle",
        sending: true,
        permissionsCount: 0,
        questionsCount: 0,
        deferredCount: 1,
      }),
    ).toBe(false)
  })

  test("does not dispatch when permissions pending", () => {
    expect(
      canDispatch({
        sessionID: "session-1",
        statusType: "idle",
        autoPhase: "idle",
        sending: false,
        permissionsCount: 1,
        questionsCount: 0,
        deferredCount: 1,
      }),
    ).toBe(false)
  })

  test("does not dispatch when questions pending", () => {
    expect(
      canDispatch({
        sessionID: "session-1",
        statusType: "idle",
        autoPhase: "idle",
        sending: false,
        permissionsCount: 0,
        questionsCount: 1,
        deferredCount: 1,
      }),
    ).toBe(false)
  })

  test("does not dispatch with empty queue", () => {
    expect(
      canDispatch({
        sessionID: "session-1",
        statusType: "idle",
        autoPhase: "idle",
        sending: false,
        permissionsCount: 0,
        questionsCount: 0,
        deferredCount: 0,
      }),
    ).toBe(false)
  })
})
