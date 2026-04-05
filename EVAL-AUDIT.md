# Eval Feature Audit Report

**Branch:** `eval-audit`
**Date:** 2026-04-04

## Intended Design

The eval feature provides an automated evaluation loop that verifies whether a build agent's work correctly fulfills the user's instructions. It operates in three modes:

1. **Interactive CLI (slash eval):** The user types `/eval` in the TUI. The eval runs as a subtask in a child session, then feeds results back to the build agent.
2. **Auto mode:** When auto mode is enabled, eval triggers automatically after the build agent goes idle. The TUI watches for build completion and sends the `/eval` command.
3. **Headless CLI (`opencode run`):** When `--eval` is passed (or implicit plan mode is active), `Eval.run()` orchestrates a full eval loop after the build completes.

The eval loop works as follows:
- Extract the user's instruction from the conversation
- Compute a diff of changes made by the build agent
- Create a child eval session with restricted permissions
- Run the eval agent, which reads files, runs tests, and calls `eval_result`
- If eval fails, send structured feedback to the build agent
- If the build agent disagrees, it can call `eval_rebuttal`
- The eval agent reviews the rebuttal and may revise its verdict
- The loop repeats up to `max` iterations (default 5) with up to 3 rebuttals per iteration

## Audit Scope

Every file and code path involved in the eval feature was inspected:

| Component | File | Lines |
|-----------|------|-------|
| Eval session logic | `src/session/eval.ts` | Full file (554 lines) |
| Eval tools | `src/tool/eval.ts` | Full file (60 lines) |
| Eval tool description | `src/tool/eval.txt` | Full file |
| Eval agent prompt | `src/agent/prompt/eval.txt` | Full file |
| Extract agent prompt | `src/agent/prompt/extract.txt` | Full file |
| Eval command template | `src/command/template/eval.txt` | Full file |
| Agent definitions | `src/agent/agent.ts` | Lines 294-327 |
| Headless eval | `src/cli/cmd/run.ts` | Lines 770-843 |
| TUI auto-trigger | `src/cli/cmd/tui/routes/session/index.tsx` | Lines 322-368, 615-653 |
| Session prompt handler | `src/session/prompt.ts` | Lines 580-688, 1655-2017, 2060-2140 |
| Permission system | `src/permission/index.ts` | Lines 296-309 |
| Permission evaluation | `src/permission/evaluate.ts` | Full file |
| LLM tool resolution | `src/session/llm.ts` | Lines 342-348 |
| Unit tests | `test/session/eval.test.ts` | Full file |
| E2E tests | `test/cli/run-eval.e2e.test.ts` | Full file |

## What Was Already Correct

### Context isolation
The eval agent runs in a child session created with explicit permission rules that deny `question`, `plan_enter`, and `plan_exit`. Each eval attempt creates a fresh child session. This prevents accidental leakage of prior reasoning or irrelevant conversation state. Behavior is consistent across all three flows (interactive, auto, headless).

### Edit tool enforcement
The eval agent's permission configuration denies `edit`, which the permission system maps to all file-editing tools: `edit`, `write`, `apply_patch`, `multiedit`. The `Permission.disabled()` function in `permission/index.ts` correctly resolves the mapping. The `resolveTools()` function in `llm.ts` filters these out before the LLM sees the tool list. This is enforced at the tool-availability level, not just the prompt level.

### Eval result parsing
`Eval.parse()` correctly extracts the verdict from `eval_result` tool calls, checking both metadata and JSON output fallback. The parsing handles edge cases (missing tool call, incomplete metadata).

### Rebuttal tool availability control
The `eval_rebuttal` tool is only made available when there is a pending failed eval and the round is within `MAX_REBUT` (3). This is correctly implemented in `prompt.ts` line 584-585.

### Auto mode eval triggering
The TUI correctly arms the eval trigger when the build agent starts (`armed = true`) and fires it when the agent goes idle. It checks for prior eval passes and respects the max iteration count.

### E2E rebuttal loop
The headless eval loop correctly handles the full cycle: eval fails → feedback to build → build rebuts → eval reviews rebuttal → eval passes. The E2E test confirms this.

### Eval nudge mechanism
When the build agent acknowledges eval feedback without taking action (no file edits and no rebuttal), the system nudges it with a system-reminder. This prevents the agent from simply agreeing with the eval and stopping.

## Issues Found and Fixed

### 1. Interactive rebuttal followup lost issue details

**Problem:** When the interactive (TUI) path processed a build agent's rebuttal, the `Eval.followup()` call at `prompt.ts:1954` passed `issues: undefined` because `Eval.State` did not include an `issues` field. The eval agent reviewing the rebuttal could only see the summary, not the specific issues being rebutted.

**Impact:** The eval agent had less context when reviewing rebuttals in interactive mode compared to headless mode, potentially leading to incorrect verdict revisions.

**Fix:**
- Added `issues?: Issue[]` to `Eval.State` type definition (`eval.ts:36`)
- Updated `parseState()` to parse issues from metadata (`eval.ts:72`)
- Updated all three places where eval state metadata is created in `prompt.ts` to include issues:
  - Initial eval failure (line 1706)
  - Post-rebuttal followup call (line 1954)
  - Post-rebuttal re-failure (line 2005)

**Verification:** New unit tests confirm issues roundtrip through state metadata. Existing rebuttal test still passes.

### 2. Inconsistent instruction extraction between TUI and headless

**Problem:** The headless path used `Eval.extract()` which creates a child session and runs the extract agent via `SessionPrompt.prompt()`. The TUI path used inline `LLM.stream()` with different message construction. This meant:
- Different context handling between flows
- The TUI extract didn't create a dedicated session
- The prompt construction differed (TUI appended "Extract the user's instructions from the conversation above" as a user message, while headless used a formatted conversation block)

**Impact:** Potential inconsistency in instruction extraction quality between interactive and headless modes.

**Fix:** Replaced the TUI inline extraction (`prompt.ts:652-688`) with a call to `Eval.extract()`, the same function used by the headless path. Both paths now share identical extraction logic.

**Verification:** Existing tests pass. The `Eval.extract()` function already handles both simple (single message) and complex (multi-message) cases.

### 3. Eval agent prompt too weak on file modification restrictions

**Problem:** The eval prompt said "Do not modify existing repo files while evaluating" but:
- It didn't explicitly mention that edit tools are disabled
- It didn't list specific bash commands that shouldn't be used for file modification
- The instruction was easy to overlook in a list of guidelines

**Impact:** While edit tools are properly denied at the permission level, the eval agent could still attempt file modifications via bash (e.g., `echo > file`, `sed -i`, `rm`). The prompt was the only defense against this.

**Fix:** Rewrote the eval agent prompt (`agent/prompt/eval.txt`) with:
- A dedicated "Restrictions" section at the top, immediately after the role description
- Explicit statement that file-editing tools are disabled
- Explicit list of bash commands that must not be used for file modification
- Clear guidance to use `/tmp` for any scratch output
- Better structured evaluation process and eval_result calling instructions

### 4. Eval feedback format not optimized for build agent consumption

**Problem:** The `feedback()` function produced a flat list of issues with `[ERROR]` and `[WARNING]` prefixes. This format:
- Mixed errors and warnings together
- Lacked clear action instructions
- Didn't explicitly tell the build agent about the rebuttal option
- Was less scannable for an LLM agent

**Fix:** Restructured `feedback()` output with:
- Separate "Errors (must fix)" and "Warnings (should fix)" sections
- File paths in backtick code formatting
- A "Required action" section with explicit instructions
- Clear mention of `eval_rebuttal` when rebuttals are available
- Different messaging when rebuttals are exhausted

### 5. System reminder for eval too vague

**Problem:** The `reminder()` system prompt told the build agent to "fix every issue raised or use the eval_rebuttal tool" but didn't provide a concrete action sequence.

**Fix:** Restructured the reminder with numbered steps:
1. Read the relevant files
2. Fix every issue by editing files
3. Run tests to confirm fixes work

This guides the agent through a concrete workflow rather than stating abstract expectations.

### 6. Eval rebuttal followup prompt lacked structure

**Problem:** The `followup()` function's prompt to the eval agent was a flat text block that mixed instructions with context.

**Fix:** Added clear section headers, numbered instructions, and explicit guidance to only change verdicts based on concrete evidence.

### 7. Instruction extraction prompt missing key rules

**Problem:** The `extract.txt` prompt didn't explicitly handle:
- User corrections ("no, I meant...")
- Changed requirements during conversation
- Ambiguous intent

**Fix:** Added rules for handling corrections, changed minds, and ambiguous intent. Strengthened the constraint preservation guidance.

### 8. Eval command template and tool descriptions improved

**Problem:** Minor clarity issues in the eval command template (`template/eval.txt`) and tool descriptions (`tool/eval.txt`, rebuttal description in `tool/eval.ts`).

**Fix:** Improved all three for clarity and consistency with the main eval prompt.

## Verification

### Unit tests (13 passing)
- 4 existing tests: all pass without modification
- 9 new tests added:
  - `feedback separates errors and warnings` — verifies structured feedback format
  - `feedback mentions rebuttal when allowed` — verifies rebuttal/no-rebuttal messaging
  - `followup includes issues when provided` — verifies issues in rebuttal followup
  - `followup works without issues` — verifies graceful handling of missing issues
  - `state parses issues from metadata` — verifies issues roundtrip through state
  - `state works without issues` — verifies backward compatibility
  - `counts non-synthetic, non-eval user text parts` — verifies instruction counting
  - `skips synthetic and eval parts` — verifies filtering logic
  - `skips eval subtask messages` — verifies subtask exclusion

### E2E test (1 passing)
- `headless run supports eval rebuttal loop` — full end-to-end test with mock LLM server verifying the eval → fail → rebuttal → review → pass cycle

### Typecheck
- `tsgo --noEmit` passes cleanly with no errors

### Manual inspection
- All three eval flows (interactive, auto, headless) traced through code
- Permission enforcement verified: edit tools disabled, bash allowed (needed for tests)
- Context isolation verified: child sessions with explicit permission rules
- Rebuttal availability verified: only when pending failed eval and within round limit

## Files Changed

| File | Change |
|------|--------|
| `src/session/eval.ts` | Added `issues` to State, improved feedback/reminder/followup formats |
| `src/session/prompt.ts` | Standardized instruction extraction, issues in eval state metadata |
| `src/agent/prompt/eval.txt` | Rewritten with explicit restrictions and better structure |
| `src/agent/prompt/extract.txt` | Improved with correction handling and ambiguity rules |
| `src/command/template/eval.txt` | Improved clarity and structure |
| `src/tool/eval.ts` | Improved rebuttal tool description |
| `src/tool/eval.txt` | Improved eval_result tool description |
| `test/session/eval.test.ts` | Added 9 new tests for feedback, state, and instruction extraction |

## Remaining Caveats

1. **Bash file modification is prompt-enforced only:** The eval agent can still theoretically modify files via bash commands. Hard enforcement would require a bash sandbox mode or command analysis, which is a larger architectural change. The strengthened prompt and the fact that edit tools are denied at the permission level provide reasonable protection.

2. **Instruction extraction creates a child session:** The `Eval.extract()` function creates a child session for the extraction agent. In the interactive path, this now creates an additional session that wasn't created before. This is a minor resource cost but improves consistency.

3. **No integration test for interactive eval path:** The interactive (TUI) eval path is tested through code inspection and unit tests but not through a full integration test. An integration test would require a TUI test harness that doesn't currently exist.

4. **Eval agent model selection:** The eval agent uses the same model as the build agent by default. For cost-sensitive deployments, a lighter model could be configured via the `agent.eval.model` config key, but this is not documented or surfaced in the UI.
