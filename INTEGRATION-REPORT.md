# Audit Integration Report

**Branch:** `audit-merge`
**Base:** `dev` (7508ee5bc)
**Date:** 2026-04-04

## Reports Reviewed

- `APPEND-AUDIT.md` (from `origin/append-audit`)
- `AUTO-MODE-AUDIT.md` (from `origin/auto-audit`)
- `EVAL-AUDIT.md` (from `origin/eval-audit`)

All three branches share the same merge base (`7508ee5bc`).

## Branch Review Summary

### append-audit (5 issues, 5 fixes)

| # | Issue | Verdict |
|---|-------|---------|
| 1 | `shouldDefer` race condition: new messages bypass queue when status is idle but dispatch is in progress | **Accepted** — real race condition, fix adds `sending()` and `deferred().length > 0` checks |
| 2 | Direct audio input (`onAudio`) bypasses append mode entirely | **Accepted** — audio path was missing the `shouldDefer()` check |
| 3 | Toast count off-by-one (`deferred().length + 1` after synchronous signal update) | **Accepted** — Solid.js signals update synchronously in event handlers |
| 4 | Deferred messages dispatched with stale agent/model captured at defer time | **Accepted** — `send()` now overrides with current selections at dispatch time |
| 5 | Eval deferral draft missing `variant` field | **Accepted** — trivial omission |

### auto-audit (11 issues, 11 fixes)

| # | Issue | Verdict |
|---|-------|---------|
| 1 | Plan prompt tells agent to ask questions even in autonomous mode | **Accepted** — direct contradiction with autonomous instructions |
| 2 | Hardcoded `/Users/aidencline/...` path in plan-reminder-anthropic.txt | **Accepted** — obvious development artifact |
| 3 | Unclear auto mode plan nudge messages | **Accepted** — rewritten for clarity and actionability |
| 4 | Headless CLI answers questions with "Yes" instead of rejecting | **Accepted** — dangerous behavior, now consistent with TUI auto mode |
| 5 | Append mode not reset when auto completes | **Accepted** — cleanup fix, prevents stale state |
| 6 | Eval prompt missing no-question instruction | **Accepted** — synthesized into eval-audit's rewrite (see conflicts below) |
| 7 | Auto-restore phase detection wrong for non-plan agents (eval, general) | **Accepted** — returns "plan" for eval agents, should be "build" |
| 8 | Permission + question handling race: single `handled` signal blocks second handler | **Accepted** — real race condition, replaced with `Set<string>` |
| 9 | Auto mode only resets on `MessageAbortedError`, not other errors | **Accepted** — provider errors, rate limits would leave user stuck |
| 10 | `RejectedError` message not actionable for agents | **Accepted** — improved message guides agent to try alternatives |
| 11 | Todo nudge missing autonomy instruction | **Accepted** — prevents agent from asking user what to do next |

### eval-audit (8 issues, 8 fixes)

| # | Issue | Verdict |
|---|-------|---------|
| 1 | Interactive rebuttal followup loses issue details (`issues: undefined`) | **Accepted** — `issues` added to `Eval.State`, propagated through all metadata paths |
| 2 | Inconsistent instruction extraction between TUI and headless | **Accepted** — TUI now uses `Eval.extract()` like headless, same code path |
| 3 | Eval agent prompt too weak on file modification restrictions | **Accepted** — full rewrite with explicit Restrictions section |
| 4 | Eval feedback format not structured for agent consumption | **Accepted** — separated errors/warnings, added required action section |
| 5 | System reminder for eval too vague | **Accepted** — numbered concrete steps instead of abstract instructions |
| 6 | Eval rebuttal followup prompt lacked structure | **Accepted** — clear section headers and evidence-based revision guidance |
| 7 | Instruction extraction prompt missing correction/ambiguity handling | **Accepted** — added rules for user corrections and changed minds |
| 8 | Eval command template and tool descriptions improved | **Accepted** — better structured, more precise |

## Conflicts and Overlaps Resolved

### 1. `agent/prompt/eval.txt` — auto-audit vs eval-audit (CONFLICT)

- **auto-audit** added a single line: "Do not ask the user questions..."
- **eval-audit** rewrote the entire file with a Restrictions section, structured evaluation process, and improved guidelines

**Resolution:** Took eval-audit's full rewrite (superior structure) and added auto-audit's no-question line into the Guidelines section. This gives us both the structural improvements and the explicit no-question instruction.

### 2. `test/session/eval.test.ts` — auto-audit vs eval-audit (no conflict, additive)

- **auto-audit** added 2 `Eval.instruction` tests (lines 185-224)
- **eval-audit** added 9 tests: feedback format, followup, state parsing, instruction extraction

**Resolution:** Both test sets merged cleanly (appended at different positions). Auto-audit's "returns empty when no real user messages exist" test adds unique coverage not in eval-audit. All tests retained.

### 3. `session/prompt.ts` — auto-audit vs eval-audit (no conflict, different regions)

- **auto-audit** modified: plan prompt conditional (line 410), plan nudge messages (lines 1538-1564), todo nudge (line 1593)
- **eval-audit** modified: instruction extraction (lines 650-688), eval state metadata (lines 1703, 1951, 2002)

**Resolution:** Both sets of changes merged cleanly with no overlapping lines. All changes retained.

### 4. `routes/session/index.tsx` — append-audit vs auto-audit (no conflict, different regions)

- **append-audit** modified: `shouldDefer` (line 231), `send()` (line 397), toast messages, eval deferral variant
- **auto-audit** modified: `handledSet` (line 304), `setAppendMode(false)` (line 349), error reset (line 377), nav cleanup (line 395)

**Resolution:** Both sets of changes merged cleanly. All changes retained.

## Integration Fix

### `prompt-effect.test.ts` — test adapted for new extraction path

The existing test "eval command resolves instruction once and inherits session context" mocked `Session.messages` to reject and asserted it was never called. This was valid when instruction extraction was inline in `prompt.ts`, but eval-audit's change to use `Eval.extract()` now calls `Session.messages` to read the parent session before short-circuiting for single-message cases.

**Fix:** Removed the `Session.messages` mock and the assertion that it wasn't called. The substantive assertions (eval prompt contains correct instruction text, session inherits agent/model, eval result is recorded) remain intact.

## No Changes Rejected

All changes from all three audit branches were accepted. Every fix was verified against the code and found to address a real issue. No changes were redundant, contradictory (after synthesis), or harmful.

## Verification

| Test Suite | Tests | Result |
|------------|-------|--------|
| `test/session/append-defer.test.ts` | 25 | Pass |
| `test/session/eval.test.ts` | 24 | Pass |
| `test/cli/tui/auto-restore.test.ts` | 12 | Pass |
| `test/session/prompt-effect.test.ts` | 20 | Pass |
| **Total** | **81** | **Pass** |

TypeScript compilation (`tsc --noEmit`): No new errors. Only pre-existing warnings/style suggestions unrelated to audit changes.

## Files Modified (from dev)

| File | Source Branch(es) | Changes |
|------|-------------------|---------|
| `src/agent/prompt/eval.txt` | auto + eval (synthesized) | Full rewrite with restrictions, structured process, no-question guideline |
| `src/agent/prompt/extract.txt` | eval | Improved correction handling, ambiguity rules |
| `src/cli/cmd/run.ts` | auto | Headless question handling: answer → reject |
| `src/cli/cmd/tui/component/prompt/auto-restore.ts` | auto | Phase detection: non-plan agents → "build" |
| `src/cli/cmd/tui/component/prompt/index.tsx` | append | Audio input respects append mode |
| `src/cli/cmd/tui/routes/session/index.tsx` | append + auto | shouldDefer fix, agent/model override, handledSet, appendMode reset, error reset |
| `src/command/template/eval.txt` | eval | Improved structure and instructions |
| `src/permission/index.ts` | auto | Actionable RejectedError message |
| `src/session/eval.ts` | eval | Issues in State, structured feedback/reminder/followup |
| `src/session/prompt.ts` | auto + eval | Conditional plan note, nudge improvements, Eval.extract(), issues in metadata |
| `src/session/prompt/plan-reminder-anthropic.txt` | auto | Removed hardcoded user path |
| `src/tool/eval.ts` | eval | Improved rebuttal tool description |
| `src/tool/eval.txt` | eval | Improved eval_result tool description |
| `test/cli/tui/auto-restore.test.ts` | auto | Tests for non-plan agent phase detection |
| `test/session/append-defer.test.ts` | append | 25 tests for defer predicate, queue, dispatch |
| `test/session/eval.test.ts` | auto + eval | 13 new tests: instruction, feedback, state, followup |
| `test/session/prompt-effect.test.ts` | integration fix | Removed stale Session.messages mock |

## Remaining Caveats

1. **No E2E tests for TUI reactive wiring.** Unit tests cover logical invariants but not Solid.js signal reactivity. All three audits noted this limitation.
2. **Eval agent bash file modification is prompt-enforced only.** Edit tools are denied at the permission level, but bash commands could still modify files. A sandbox would require larger architectural work.
3. **No deferred message cancellation UI.** Users can toggle append mode off but cannot clear the existing queue.
4. **Audio deferral stores base64 in memory.** Could be large for long recordings. Consider temp file storage.
5. **`plan-reminder-anthropic.txt` may be vestigial.** Auto-audit noted it doesn't appear to be dynamically imported. Consider removing if confirmed unused.
