import { describe, expect, test } from "bun:test"

/**
 * Pure predicate tests for every createEffect in the TUI session component.
 *
 * Each effect in session/index.tsx is modeled as a pure function here so we
 * can test the branching logic without Solid.js reactivity.
 */

// ── shouldResetSending ────────────────────────────────────────────
// Mirrors the effect at session/index.tsx ~line 438:
//   createEffect(() => {
//     if (!sending()) return
//     if (status().type !== "idle" || local.agent.auto.phase() !== "idle") {
//       setSending(false)
//     }
//   })

function shouldResetSending(opts: { sending: boolean; statusType: string; autoPhase: string }): boolean {
  if (!opts.sending) return false
  return opts.statusType !== "idle" || opts.autoPhase !== "idle"
}

describe("shouldResetSending", () => {
  test("returns false when sending is false (no-op)", () => {
    expect(shouldResetSending({ sending: false, statusType: "busy", autoPhase: "build" })).toBe(false)
  })

  test("returns true when sending and status goes non-idle", () => {
    expect(shouldResetSending({ sending: true, statusType: "busy", autoPhase: "idle" })).toBe(true)
  })

  test("returns true when sending and autoPhase goes non-idle", () => {
    expect(shouldResetSending({ sending: true, statusType: "idle", autoPhase: "build" })).toBe(true)
  })

  test("returns false when sending but both still idle", () => {
    expect(shouldResetSending({ sending: true, statusType: "idle", autoPhase: "idle" })).toBe(false)
  })

  test("returns true when both status and autoPhase are non-idle", () => {
    expect(shouldResetSending({ sending: true, statusType: "busy", autoPhase: "plan" })).toBe(true)
  })
})

// ── shouldTriggerEval ─────────────────────────────────────────────
// Mirrors the eval trigger effect at session/index.tsx ~line 326:
//   let armed = false
//   createEffect(() => {
//     if (!auto()) return
//     if (local.agent.auto.phase() !== "build") { armed = false; return }
//     if (status().type !== "idle") { armed = true; return }
//     if (!armed) return
//     armed = false
//     // ... fire eval
//   })

type EvalTriggerAction = "disabled" | "disarm" | "arm" | "fire" | "skip"

function shouldTriggerEval(opts: {
  auto: boolean
  phase: string
  statusType: string
  armed: boolean
}): { action: EvalTriggerAction; armed: boolean } {
  if (!opts.auto) return { action: "disabled", armed: opts.armed }
  if (opts.phase !== "build") return { action: "disarm", armed: false }
  if (opts.statusType !== "idle") return { action: "arm", armed: true }
  if (!opts.armed) return { action: "skip", armed: false }
  return { action: "fire", armed: false }
}

describe("shouldTriggerEval", () => {
  test("returns disabled when auto is false", () => {
    const result = shouldTriggerEval({ auto: false, phase: "build", statusType: "idle", armed: true })
    expect(result.action).toBe("disabled")
  })

  test("disarms when phase is not build", () => {
    const result = shouldTriggerEval({ auto: true, phase: "plan", statusType: "idle", armed: true })
    expect(result.action).toBe("disarm")
    expect(result.armed).toBe(false)
  })

  test("arms when phase is build and status is not idle", () => {
    const result = shouldTriggerEval({ auto: true, phase: "build", statusType: "busy", armed: false })
    expect(result.action).toBe("arm")
    expect(result.armed).toBe(true)
  })

  test("fires when phase is build, status idle, and armed", () => {
    const result = shouldTriggerEval({ auto: true, phase: "build", statusType: "idle", armed: true })
    expect(result.action).toBe("fire")
    expect(result.armed).toBe(false)
  })

  test("skips when phase is build, status idle, but not armed", () => {
    const result = shouldTriggerEval({ auto: true, phase: "build", statusType: "idle", armed: false })
    expect(result.action).toBe("skip")
    expect(result.armed).toBe(false)
  })

  test("full arming cycle: busy -> arm -> idle -> fire", () => {
    // Step 1: agent starts working
    const step1 = shouldTriggerEval({ auto: true, phase: "build", statusType: "busy", armed: false })
    expect(step1.action).toBe("arm")
    expect(step1.armed).toBe(true)

    // Step 2: agent finishes -> idle
    const step2 = shouldTriggerEval({ auto: true, phase: "build", statusType: "idle", armed: step1.armed })
    expect(step2.action).toBe("fire")
    expect(step2.armed).toBe(false)
  })
})

// ── shouldResetAuto ───────────────────────────────────────────────
// Mirrors auto completion at session/index.tsx ~line 342:
//   const iter = local.agent.auto.iter()
//   if (iter > 0) {
//     const passed = msgs.some(...)
//     if (passed || iter >= local.agent.auto.MAX) {
//       local.agent.auto.reset()
//       setAppendMode(false)
//       return
//     }
//   }

function shouldResetAuto(opts: { iter: number; passed: boolean; max: number }): boolean {
  if (opts.iter <= 0) return false
  return opts.passed || opts.iter >= opts.max
}

describe("shouldResetAuto", () => {
  test("returns false when iter is 0 (first iteration, eval not yet run)", () => {
    expect(shouldResetAuto({ iter: 0, passed: false, max: 5 })).toBe(false)
  })

  test("returns true when iter > 0 and eval passed", () => {
    expect(shouldResetAuto({ iter: 1, passed: true, max: 5 })).toBe(true)
  })

  test("returns true when iter reaches max", () => {
    expect(shouldResetAuto({ iter: 5, passed: false, max: 5 })).toBe(true)
  })

  test("returns true when iter exceeds max", () => {
    expect(shouldResetAuto({ iter: 6, passed: false, max: 5 })).toBe(true)
  })

  test("returns false when iter > 0 but not passed and under max", () => {
    expect(shouldResetAuto({ iter: 2, passed: false, max: 5 })).toBe(false)
  })

  test("returns true on pass even at iter 1", () => {
    expect(shouldResetAuto({ iter: 1, passed: true, max: 5 })).toBe(true)
  })
})

// ── shouldResetOnError ────────────────────────────────────────────
// Mirrors the error-reset effect at session/index.tsx ~line 370:
//   if (evt.properties.info.error) {
//     local.agent.auto.reset()
//   }
// Guarded by: auto() && phase() !== "idle"

function shouldResetOnError(opts: { auto: boolean; phase: string; error: unknown }): boolean {
  if (!opts.auto) return false
  if (opts.phase === "idle") return false
  return !!opts.error
}

describe("shouldResetOnError", () => {
  test("returns true when auto, phase not idle, and error present", () => {
    expect(shouldResetOnError({ auto: true, phase: "build", error: new Error("rate limit") })).toBe(true)
  })

  test("returns true for any truthy error value", () => {
    expect(shouldResetOnError({ auto: true, phase: "plan", error: { name: "ProviderError" } })).toBe(true)
  })

  test("returns false when auto is false", () => {
    expect(shouldResetOnError({ auto: false, phase: "build", error: new Error() })).toBe(false)
  })

  test("returns false when phase is idle", () => {
    expect(shouldResetOnError({ auto: true, phase: "idle", error: new Error() })).toBe(false)
  })

  test("returns false when error is falsy", () => {
    expect(shouldResetOnError({ auto: true, phase: "build", error: undefined })).toBe(false)
    expect(shouldResetOnError({ auto: true, phase: "build", error: null })).toBe(false)
  })
})

// ── sessionNavCleanup ─────────────────────────────────────────────
// Mirrors session navigation effect at session/index.tsx ~line 382:
//   on(() => route.sessionID, (next) => {
//     const reset = seen !== undefined && seen !== next
//     seen = next
//     if (!reset) return
//     // ... clear all state
//   })

function shouldResetOnNav(opts: { seen: string | undefined; next: string | undefined }): {
  reset: boolean
  seen: string | undefined
} {
  const reset = opts.seen !== undefined && opts.seen !== opts.next
  return { reset, seen: opts.next }
}

describe("sessionNavCleanup", () => {
  test("does not reset on first load (seen=undefined)", () => {
    const result = shouldResetOnNav({ seen: undefined, next: "session-1" })
    expect(result.reset).toBe(false)
    expect(result.seen).toBe("session-1")
  })

  test("does not reset when navigating to same session", () => {
    const result = shouldResetOnNav({ seen: "session-1", next: "session-1" })
    expect(result.reset).toBe(false)
  })

  test("resets when navigating to different session", () => {
    const result = shouldResetOnNav({ seen: "session-1", next: "session-2" })
    expect(result.reset).toBe(true)
    expect(result.seen).toBe("session-2")
  })

  test("resets when navigating away from session (next=undefined)", () => {
    const result = shouldResetOnNav({ seen: "session-1", next: undefined })
    expect(result.reset).toBe(true)
    expect(result.seen).toBeUndefined()
  })

  test("tracks seen across multiple navigations", () => {
    let seen: string | undefined = undefined

    // First load
    const r1 = shouldResetOnNav({ seen, next: "s1" })
    seen = r1.seen
    expect(r1.reset).toBe(false)

    // Navigate to s2
    const r2 = shouldResetOnNav({ seen, next: "s2" })
    seen = r2.seen
    expect(r2.reset).toBe(true)

    // Navigate to s3
    const r3 = shouldResetOnNav({ seen, next: "s3" })
    seen = r3.seen
    expect(r3.reset).toBe(true)

    // Stay on s3
    const r4 = shouldResetOnNav({ seen, next: "s3" })
    expect(r4.reset).toBe(false)
  })
})

// ── autoRejectPermissionsAndQuestions ──────────────────────────────
// Mirrors the effect at session/index.tsx ~line 304:
//   const handledSet = new Set<string>()
//   createEffect(() => {
//     if (!auto()) return
//     const permission = permissions()[0]
//     if (permission && !handledSet.has(permission.id)) { ... }
//     const q = questions()[0]
//     if (q && !handledSet.has(q.id)) { ... }
//   })

function autoReject(opts: {
  auto: boolean
  permission?: { id: string } | undefined
  question?: { id: string } | undefined
  handledSet: Set<string>
}): { rejectedPermission: string | undefined; rejectedQuestion: string | undefined } {
  if (!opts.auto) return { rejectedPermission: undefined, rejectedQuestion: undefined }

  let rejectedPermission: string | undefined
  let rejectedQuestion: string | undefined

  if (opts.permission && !opts.handledSet.has(opts.permission.id)) {
    opts.handledSet.add(opts.permission.id)
    rejectedPermission = opts.permission.id
  }

  if (opts.question && !opts.handledSet.has(opts.question.id)) {
    opts.handledSet.add(opts.question.id)
    rejectedQuestion = opts.question.id
  }

  return { rejectedPermission, rejectedQuestion }
}

describe("autoRejectPermissionsAndQuestions", () => {
  test("skips everything when auto is false", () => {
    const handledSet = new Set<string>()
    const result = autoReject({
      auto: false,
      permission: { id: "perm-1" },
      question: { id: "q-1" },
      handledSet,
    })
    expect(result.rejectedPermission).toBeUndefined()
    expect(result.rejectedQuestion).toBeUndefined()
    expect(handledSet.size).toBe(0)
  })

  test("handles permission not in handledSet", () => {
    const handledSet = new Set<string>()
    const result = autoReject({ auto: true, permission: { id: "perm-1" }, handledSet })
    expect(result.rejectedPermission).toBe("perm-1")
    expect(handledSet.has("perm-1")).toBe(true)
  })

  test("skips permission already in handledSet", () => {
    const handledSet = new Set(["perm-1"])
    const result = autoReject({ auto: true, permission: { id: "perm-1" }, handledSet })
    expect(result.rejectedPermission).toBeUndefined()
  })

  test("handles question not in handledSet", () => {
    const handledSet = new Set<string>()
    const result = autoReject({ auto: true, question: { id: "q-1" }, handledSet })
    expect(result.rejectedQuestion).toBe("q-1")
    expect(handledSet.has("q-1")).toBe(true)
  })

  test("handles BOTH permission and question in same cycle", () => {
    const handledSet = new Set<string>()
    const result = autoReject({
      auto: true,
      permission: { id: "perm-1" },
      question: { id: "q-1" },
      handledSet,
    })
    expect(result.rejectedPermission).toBe("perm-1")
    expect(result.rejectedQuestion).toBe("q-1")
    expect(handledSet.size).toBe(2)
  })

  test("handledSet grows across multiple calls (deduplication)", () => {
    const handledSet = new Set<string>()

    // First call: handle both
    const r1 = autoReject({
      auto: true,
      permission: { id: "perm-1" },
      question: { id: "q-1" },
      handledSet,
    })
    expect(r1.rejectedPermission).toBe("perm-1")
    expect(r1.rejectedQuestion).toBe("q-1")

    // Second call: same IDs — both skipped
    const r2 = autoReject({
      auto: true,
      permission: { id: "perm-1" },
      question: { id: "q-1" },
      handledSet,
    })
    expect(r2.rejectedPermission).toBeUndefined()
    expect(r2.rejectedQuestion).toBeUndefined()

    // Third call: new permission, same question
    const r3 = autoReject({
      auto: true,
      permission: { id: "perm-2" },
      question: { id: "q-1" },
      handledSet,
    })
    expect(r3.rejectedPermission).toBe("perm-2")
    expect(r3.rejectedQuestion).toBeUndefined()
    expect(handledSet.size).toBe(3)
  })

  test("does nothing when no permission or question provided", () => {
    const handledSet = new Set<string>()
    const result = autoReject({ auto: true, handledSet })
    expect(result.rejectedPermission).toBeUndefined()
    expect(result.rejectedQuestion).toBeUndefined()
    expect(handledSet.size).toBe(0)
  })
})
