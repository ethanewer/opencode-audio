# Eval child session DB read issue

## Summary

When the `/eval` command runs in the interactive TUI, the parent session cannot reliably read message parts from the eval child session after the subtask completes. `Session.messages()` returns the assistant message but with 0 parts. This prevents the parent from confirming whether the eval agent called `eval_result` with `pass: true` or `pass: false`.

## Current workaround

In `prompt.ts`, the eval result check defaults `passed = true`. If the result cannot be read, the user sees "Eval completed." (neutral) instead of "Eval passed." (confirmed). The build agent is not notified of failure in this case.

The eval subtask itself works correctly — the user can click into the child session and see all tool calls including `eval_result`. The issue is only with reading the result back from the parent context.

## Reproduction

1. Start the TUI
2. Build something (e.g. `Create hello.txt with hello`)
3. Run `/eval`
4. The eval subtask runs and completes (visible in the UI)
5. In `prompt.ts` around line 1553, `Session.messages({ sessionID: childId })` returns messages where the assistant message has `parts: []`

## Where the read happens

`packages/opencode/src/session/prompt.ts` — inside the `runLoop` function, after `handleSubtask` returns for an eval command. The code at ~line 1538 calls `Session.messages()` (the public API) which internally calls `runPromise()` creating a nested Effect runtime.

## What works

- **Headless path** (`run.ts` → `Eval.run()`): `Session.messages()` returns parts correctly. `Eval.run()` is called from `bootstrap()` context, not from within an Effect prompt loop.
- **Within the child session's own prompt loop**: Parts are read and written correctly (the eval agent uses tools, calls eval_result, etc.)
- **TUI rendering**: The sync store receives parts via SSE events and displays them in the UI.

## What doesn't work

- **Reading child session parts from the parent prompt loop**: `Session.messages()` called from within `handleSubtask` (which runs inside `runLoop` → `runner.ensureRunning`) returns 0 parts for the child session's assistant message.

## Suspected causes

Not fully diagnosed. Possibilities:

1. **Effect `ManagedRuntime` scope**: The nested `runPromise()` inside `Session.messages()` may create a runtime whose scope interferes with the outer prompt loop's runtime. The `InstanceState.get(cache)` uses a `ScopedCache` keyed by directory — the inner runtime may resolve a different state.

2. **SQLite read timing**: Bun's SQLite is synchronous, but the `SyncEvent.run()` that writes parts uses `Database.transaction({ behavior: "immediate" })`. If the outer prompt loop has an open transaction context (via `AsyncLocalStorage`), the inner read may not see committed data.

3. **`AsyncLocalStorage` propagation**: `Effect.promise()` wraps an async function. The `runPromise()` inside `Session.messages()` creates a new Effect fiber. ALS context may not propagate correctly through this chain in Bun's runtime.

## Files involved

- `packages/opencode/src/session/prompt.ts` — the read attempt (~line 1538-1554)
- `packages/opencode/src/session/index.ts` — `Session.messages()` public API (~line 740)
- `packages/opencode/src/session/message-v2.ts` — `MessageV2.stream()` and `MessageV2.page()` which read from DB
- `packages/opencode/src/effect/run-service.ts` — `makeRuntime` and `runPromise`
- `packages/opencode/src/storage/db.ts` — `Database.use()` and `Database.transaction()`
