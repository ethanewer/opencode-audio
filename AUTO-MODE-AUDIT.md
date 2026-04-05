# Auto Mode Audit Report

## Intended Design

Auto mode is an autonomous execution mode for opencode that runs a complete plan-build-eval loop without user intervention:

1. **Planning**: Agent explores the codebase, designs an approach, writes a plan file
2. **Building**: Agent executes the plan, making file edits and running commands
3. **Evaluation**: A separate eval agent reviews the build output for correctness
4. **Iteration**: If eval fails, feedback is sent back to the build agent; this loops up to a configurable max

The user should be able to switch to auto mode, send a message, and have the system complete work without stalling on questions, permission dialogs, or other unnecessary pauses.

## Audit Scope

This audit covered all auto mode execution paths across both interactive (TUI) and headless (CLI `opencode run`) surfaces:

- Core orchestration loop (`session/prompt.ts` `runLoop`)
- TUI auto mode state management (`tui/context/local.tsx`)
- TUI auto mode orchestration (`tui/routes/session/index.tsx`)
- TUI prompt dispatch (`tui/component/prompt/index.tsx`)
- Auto mode restoration on reconnect (`tui/component/prompt/auto-restore.ts`)
- Headless CLI (`cli/cmd/run.ts`)
- Plan-to-build handoff (`tool/plan.ts`, `session/prompt.ts`)
- Eval loop (`session/eval.ts`)
- Permission system (`permission/index.ts`)
- Question handling (`question/index.ts`)
- All related prompts (plan, build-switch, eval, nudges, plan-exit)
- Append mode interaction with auto mode
- Mode switching scenarios

## Flows and Code Paths Inspected

### TUI Auto Mode Flow
1. User selects "auto" agent and sends message
2. `dispatchDraft()` sets auto permissions (question=deny, plan_enter=deny, plan_exit=deny, tui_auto=deny)
3. `auto.start()` sets phase to "plan", iter to 0
4. Backend resolves "auto" to "plan" agent via `agent.resolve()`
5. Plan agent runs with autonomous prompts (no user questions, no plan_exit call needed)
6. When plan finishes, `runLoop` detects plan_exit=deny permission, reads plan file, injects synthetic build handoff
7. TUI detects handoff metadata, sets phase to "build"
8. Build agent executes the plan
9. When build goes idle, TUI triggers eval command
10. Eval subtask runs in child session, returns verdict
11. If failed: feedback injected, loop continues; if passed or max iterations: auto.reset()

### Headless CLI Flow
1. `opencode run` command parses args, sets `OPENCODE_CLI_PLAN_AUTO_BUILD=1`
2. Creates session with deny rules for question, plan_enter, plan_exit
3. Plan agent runs, PlanExitTool auto-approves due to env var
4. Build agent runs
5. After build completes, `Eval.run()` executes the eval loop externally
6. Results printed, exit code set based on pass/fail

### Permission Handling
- TUI: reactive effect auto-rejects permissions and questions via SDK
- Headless: event listener auto-rejects permissions, auto-rejects questions
- Backend: `question=deny` permission prevents question tool from blocking

### Append Interaction
- Append mode defers messages until both `status=idle` and `auto.phase=idle`
- Deferred messages are dispatched one at a time via `send()`
- Each deferred auto message starts a fresh auto cycle

### Mode Switching
- Switching from auto to another mode: permissions restored from saved state
- Switching to auto mid-session: permissions applied, auto.start() called
- Session navigation: full auto state reset including deferred queue

## What Was Already Working Correctly

1. **Core plan-build loop**: The `runLoop` in `prompt.ts` correctly handles plan detection, plan file reading, synthetic build handoff injection, and loop continuation. The auto vs interactive branching (via `plan_exit` permission evaluation) is well designed.

2. **Eval loop orchestration**: Both headless (`Eval.run`) and interactive (`handleSubtask` + eval effect) paths correctly implement the eval-feedback-rebuttal cycle with proper round counting and max iteration guards.

3. **TUI auto state management**: The `local.tsx` context properly tracks phase, iteration count, and sync state. The `auto.rules()` function correctly generates the full permission ruleset.

4. **Permission save/restore**: When switching modes, the TUI correctly saves original permissions and restores them when leaving auto mode.

5. **Auto-restore on reconnect**: The `auto-restore.ts` module correctly detects auto mode from session permissions and determines the current phase from message metadata.

6. **Deferred message queue**: The append+auto interaction correctly waits for both idle status and idle auto phase before dispatching the next message.

7. **Eval instruction extraction**: `Eval.instruction()` properly filters out synthetic, eval-tagged, and ignored messages to extract the original user intent.

8. **Todo nudge system**: Correctly limits nudges to `MAX_TODO_NUDGES` (3) and only fires for build agents with incomplete todos.

9. **Voice agent fallback**: Correctly detects when voice agent doesn't use speak tool and nudges once.

10. **Eval action nudge**: Correctly detects when build agent acknowledges eval feedback without taking action, limited to `MAX_EVAL_NUDGES` (2).

## Issues Found and Fixed

### Issue 1: Contradictory plan prompt in autonomous mode
**File**: `session/prompt.ts` line 410
**Problem**: The plan prompt's final `NOTE:` paragraph always told the agent to "feel free to ask the user questions or clarifications" even when `autonomous=true`, directly contradicting the autonomous-specific instructions above it.
**Fix**: Conditionally omit the note paragraph when `autonomous` is true.
**Verification**: Code review confirms the `autonomous` variable is correctly derived from `Permission.evaluate("question", "*", rules).action === "deny"`.

### Issue 2: Hardcoded user-specific path in plan-reminder-anthropic.txt
**File**: `session/prompt/plan-reminder-anthropic.txt` line 9
**Problem**: Contained a hardcoded path `/Users/aidencline/.claude/plans/happy-waddling-feigenbaum.md` from a development session, making the template non-generic.
**Fix**: Replaced with generic instruction to use the plan file path from session context.
**Verification**: File review confirms the template is now generic.

### Issue 3: Unclear auto mode plan nudge messages
**File**: `session/prompt.ts` lines 1536-1564
**Problem**: When the plan agent finished incorrectly in auto mode (no plan file written), the nudge messages were vague about what the agent should do. The first nudge said "you must finish with the finalized plan written to the plan file" but didn't clearly state the agent should write it now and then stop.
**Fix**: Rewrote both first and repeat nudge messages to be explicit: "Write the finalized plan to the plan file using the write or edit tool, then end your turn. The build phase will start automatically."
**Verification**: Code review confirms the messages are now actionable and unambiguous.

### Issue 4: Headless CLI answered questions with "Yes" instead of rejecting
**File**: `cli/cmd/run.ts` lines 636-644
**Problem**: When a question was asked in headless mode, the handler answered with `["Yes"]` instead of rejecting. This meant arbitrary questions from the agent would get "Yes" answers, potentially causing incorrect behavior. The TUI auto mode correctly rejects questions.
**Fix**: Changed to `sdk.question.reject()` to match TUI behavior.
**Verification**: Confirmed `question.reject` API exists in the SDK. Both surfaces now handle questions consistently.

### Issue 5: Append mode not reset when auto completes
**File**: `tui/routes/session/index.tsx` line 348
**Problem**: When auto mode completed (eval passed or max iterations), `auto.reset()` was called but `appendMode` was not cleared. If the user had toggled append mode during auto, it would remain enabled after auto finished.
**Fix**: Added `setAppendMode(false)` when auto mode completes via the eval iteration check.
**Verification**: Code path analysis confirms this is the correct location for cleanup.

### Issue 6: Eval prompt missing no-question instruction
**File**: `agent/prompt/eval.txt`
**Problem**: The eval agent prompt didn't instruct the agent to avoid asking questions. In auto mode, questions are auto-rejected, but the agent might waste turns attempting to ask questions before getting the rejection.
**Fix**: Added "Do not ask the user questions. Make reasonable assumptions and proceed with the evaluation using the evidence available to you." to the guidelines.
**Verification**: This aligns with how both headless and TUI auto modes handle questions (rejection).

### Issue 7: Auto-restore phase detection incorrect for non-plan agents
**File**: `tui/component/prompt/auto-restore.ts` line 33
**Problem**: The `phase()` function used `=== "build"` to detect build phase and defaulted everything else to "plan". This meant agents like "eval" or "general" (during subtasks) would incorrectly show as "plan" phase.
**Fix**: Changed logic so only "plan" agent maps to "plan" phase; all other agents (build, eval, general, etc.) map to "build" phase.
**Verification**: Added test cases for "eval" and "general" agents confirming they return `phase: "build"`. All 15 tests pass.

### Issue 8: TUI permission+question handling race condition
**File**: `tui/routes/session/index.tsx` lines 299-320
**Problem**: A single `handled` signal was used for both permission and question auto-rejection. If a permission and question arrived in the same reactive cycle, the permission's early `return` would prevent the question from being handled, potentially stalling the loop.
**Fix**: Replaced with a `Set<string>` to track handled IDs independently, and removed the early return so both permissions and questions are processed in the same effect cycle.
**Verification**: Code review confirms both branches now execute independently. Set is cleared on session navigation.

### Issue 9: Auto mode not reset on non-abort errors
**File**: `tui/routes/session/index.tsx` lines 368-377
**Problem**: Auto mode only reset on `MessageAbortedError` but not on other errors (provider errors, rate limits, network failures). This could leave the user stuck in a non-functional auto state.
**Fix**: Changed condition from `error?.name === "MessageAbortedError"` to `error` (any error resets auto).
**Verification**: Code review confirms this correctly handles all error types.

### Issue 10: Permission error messages not actionable
**File**: `permission/index.ts` line 85
**Problem**: The `RejectedError` message said "The user rejected permission to use this specific tool call" which doesn't help the agent try an alternative. In auto mode, it's not even the user rejecting — it's the system.
**Fix**: Changed to "Permission to use this tool call was denied. Try an alternative approach that does not require this permission, or proceed without it."
**Verification**: No tests reference the old message text. The new message is provider-agnostic and actionable.

### Issue 11: Todo nudge missing autonomy instruction
**File**: `session/prompt.ts` line 1596
**Problem**: The todo nudge told the agent to continue working but didn't prevent it from asking the user what to do next, which would stall auto mode.
**Fix**: Added "Do not ask the user what to do next -- proceed with the next incomplete item now." to the nudge.
**Verification**: Consistent with other autonomous behavior in the system.

## Verification Summary

| Test | Result |
|------|--------|
| `test/cli/tui/auto-restore.test.ts` (10 tests) | Pass |
| `test/session/eval.test.ts` (5 tests) | Pass |
| New: non-plan agents map to build phase | Pass |
| New: Eval.instruction filters synthetic messages | Pass |
| New: Eval.instruction handles empty real messages | Pass |
| TypeScript compilation (modified files) | No new errors |

## Files Modified

| File | Changes |
|------|---------|
| `packages/opencode/src/session/prompt.ts` | Conditional plan note for autonomous mode; improved plan nudge messages; improved todo nudge |
| `packages/opencode/src/session/prompt/plan-reminder-anthropic.txt` | Removed hardcoded user path |
| `packages/opencode/src/cli/cmd/run.ts` | Changed question handling from answer to reject |
| `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` | Fixed permission/question race; reset appendMode on auto complete; reset auto on any error; clear handledSet on navigation |
| `packages/opencode/src/cli/cmd/tui/component/prompt/auto-restore.ts` | Fixed phase detection for non-plan agents |
| `packages/opencode/src/agent/prompt/eval.txt` | Added no-question instruction |
| `packages/opencode/src/permission/index.ts` | Improved RejectedError message |
| `packages/opencode/test/cli/tui/auto-restore.test.ts` | Added tests for non-plan agent phase detection |
| `packages/opencode/test/session/eval.test.ts` | Added Eval.instruction filtering tests |

## Remaining Caveats and Follow-up Items

1. **No integration test for full auto cycle**: The auto mode involves multiple async processes across TUI rendering, backend session management, and LLM calls. A full end-to-end integration test would require significant test infrastructure (mock LLM, TUI rendering engine). The current unit tests cover the individual components well.

2. **Eval iteration count not visible in TUI**: When auto mode runs multiple eval iterations, the user sees phase changes but no iteration counter in the UI. This is a minor UX improvement opportunity.

3. **Deferred message ordering**: Deferred messages are sent one at a time in order, but if a deferred message fails, the queue stalls. An explicit retry or skip mechanism could improve resilience.

4. **plan-reminder-anthropic.txt appears unused**: This file contains a detailed plan workflow but doesn't appear to be dynamically imported. The actual plan prompt is generated in `insertReminders()` in `prompt.ts`. The file may be vestigial or used by an external tool. Consider removing if confirmed unused.

5. **Voice auto mode untested**: Voice auto mode (`voice-plan` -> `voice-build`) follows the same paths with voice agent resolution but has no dedicated test coverage.

6. **Pre-existing TypeScript errors**: The codebase has pre-existing type errors in `github/index.ts` and TUI component files related to missing path aliases and dependencies. These are unrelated to auto mode.
