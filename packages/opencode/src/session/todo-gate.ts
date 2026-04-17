import type { SessionID } from "./schema"
import { Todo } from "./todo"
import { Permission } from "@/permission"
import { READ_ONLY_BASH } from "@/permission/read-only-bash"

export namespace TodoGate {
  /**
   * Check whether side-effect tool calls are currently allowed. They are
   * allowed only when the todo list has at least one in_progress entry with
   * populated notes. This forces the model to articulate a plan before it
   * changes state, while still permitting read-only exploration first.
   *
   * The gate is opt-in via the caller's permission ruleset. It is active only
   * when the ruleset explicitly allows todowrite. When the ruleset is
   * undefined (direct programmatic callers — plugins, SDK users, unit tests
   * for tools) or denies todowrite (the model has no way to make a plan), the
   * gate is disabled and side-effect tools run without the plan check.
   */
  export function allow(
    sessionID: SessionID,
    ruleset?: Permission.Ruleset,
  ): { ok: true } | { ok: false; reason: string } {
    if (!ruleset) return { ok: true }
    if (Permission.evaluate("todowrite", "*", ruleset).action !== "allow") {
      return { ok: true }
    }
    const todos = Todo.get(sessionID)
    if (todos.length === 0) {
      return {
        ok: false,
        reason:
          "You do not have a todo list yet. Before you can use side-effect tools (write, edit, apply_patch, or state-changing shell commands), call todowrite with a short plan. Read-only exploration (read, ls, cat, grep, file, etc.) is always available without a todo list.",
      }
    }
    const active = todos.filter((t) => t.status === "in_progress")
    if (active.length === 0) {
      return {
        ok: false,
        reason:
          "No todo is currently in_progress. Before side-effect tools, set the todo you are about to work on to in_progress via todowrite and write your current plan into its notes field (the specific commands/edits you are about to run and the outcome you expect). Read-only exploration (read, ls, cat, grep, file, find, etc.) is still allowed.",
      }
    }
    for (const t of active) {
      const notes = (t.notes ?? "").trim()
      if (notes.length < 12) {
        return {
          ok: false,
          reason: `Your in_progress todo ${JSON.stringify(t.content)} has empty or too-short notes. Before using side-effect tools, call todowrite and populate its notes field with at least one full sentence describing your hypothesis, the specific commands/edits you are about to run, and the outcome you expect.`,
        }
      }
    }
    return { ok: true }
  }

  /**
   * Classify a shell command string as read-only or side-effect by evaluating
   * it against the shared plan-mode bash allowlist (READ_ONLY_BASH). Reuses
   * the exact same rules the plan agent uses to restrict shell commands.
   *
   * Returns "read-only" when the command would be allowed in plan mode (and
   * therefore has no side effects), "side-effect" otherwise. Empty or
   * whitespace-only commands are treated as read-only (they are usually
   * duration-only polls with no keystrokes).
   */
  export function classifyShell(pattern: string): "read-only" | "side-effect" {
    const trimmed = pattern.trim()
    if (!trimmed) return "read-only"
    // Evaluate as the permission system does: look up "bash" with the given
    // pattern against the shared ruleset. "allow" means read-only; anything
    // else (deny, ask) means side-effect.
    const ruleset = Permission.fromConfig({ bash: READ_ONLY_BASH })
    const rule = Permission.evaluate("bash", trimmed, ruleset)
    return rule.action === "allow" ? "read-only" : "side-effect"
  }

  export function blockMessage(toolName: string, reason: string) {
    return [
      `The \`${toolName}\` tool call was blocked because you have not recorded a plan for the work you are about to do.`,
      "",
      reason,
      "",
      "Call todowrite first. Read-only tools (read, ls, cat, grep, find, file, git status/log/diff, etc.) remain available at any time.",
    ].join("\n")
  }
}
