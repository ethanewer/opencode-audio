# OpenCode Run Agent Options

This note explains how agent selection works for `opencode run`.

All command examples below were validated in sandboxed temporary repos against the local CLI entrypoint. For repeatable examples, the plan-flow commands use `--eval false` so they only demonstrate agent selection and handoff.

## Default behavior

Plain `opencode run` now starts in `plan` mode by default.

```bash
opencode run --eval false "Implement the requested change"
```

What happens:

- Starts with the `plan` agent.
- Allows `plan_exit` handoff.
- Auto-handoffs into `build` when the plan is approved.
- If you omit `--eval false`, eval still runs after build.

## Disable the default plan handoff

Set `OPENCODE_EXPERIMENTAL_PLAN_MODE=0` to opt out of the default plan flow.

```bash
OPENCODE_EXPERIMENTAL_PLAN_MODE=0 opencode run --eval false "Implement the requested change"
```

What happens:

- Does not auto-switch into `plan`.
- Uses the normal default primary agent flow.
- Does not enable `plan_exit` handoff unless you explicitly pick a plan agent.

## Explicit build only

Use `--agent build` when you want a direct build pass with no planning step.

```bash
opencode run --agent build --eval false "Implement the requested change"
```

What happens:

- Starts directly with `build`.
- No implicit plan handoff.
- Eval stays off here because the command explicitly sets `--eval false`.

## Explicit plan handoff

Use `--agent plan` when you want to force plan mode explicitly.

```bash
opencode run --agent plan --eval false "Plan and then implement the requested change"
```

What happens:

- Starts with `plan` even if default plan mode is disabled.
- Keeps `plan_exit` available.
- Auto-handoffs into `build` after plan approval.

## Custom primary agents

You can pass any configured primary agent name.

```bash
opencode run --agent qa --eval false "Review the requested change"
```

What happens:

- Starts with the named primary agent.
- No implicit plan handoff unless that agent is `plan`.
- Useful for project-specific agents like `qa`, `review`, or `release`.

## Summary

Use these rules when choosing an agent for `opencode run`:

| Command form                                         | Behavior                             |
| ---------------------------------------------------- | ------------------------------------ |
| `opencode run ...`                                   | Default `plan -> build -> eval` flow |
| `OPENCODE_EXPERIMENTAL_PLAN_MODE=0 opencode run ...` | Legacy non-plan default flow         |
| `opencode run --agent build ...`                     | Direct build only                    |
| `opencode run --agent plan ...`                      | Explicit `plan -> build`             |
| `opencode run --agent <primary-agent> ...`           | Use the named primary agent          |
