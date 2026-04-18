import { Instance } from "../project/instance"

import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"
import { get as getTmpdir } from "./tmpdir"

let cached: string[] | undefined

async function snapshot(): Promise<string[]> {
  if (cached) return cached
  try {
    const darwin = process.platform === "darwin"
    const prefixed = (name: string, bin: string, args = "--version") =>
      `(command -v ${bin} >/dev/null 2>&1 && echo "${name} $(${bin} ${args} 2>&1 | head -1)" || echo '${name}: not found')`
    const raw = (bin: string, args = "--version") =>
      `(command -v ${bin} >/dev/null 2>&1 && ${bin} ${args} 2>&1 | head -1 || echo '${bin}: not found')`
    const cmd = [
      "echo '@@SHELL@@'",
      "echo $SHELL",
      "echo '@@LANG@@'",
      prefixed("node", "node"),
      raw("python3"),
      raw("go", "version"),
      raw("rustc"),
      raw("java", "-version"),
      prefixed("bun", "bun"),
      raw("deno"),
      "echo '@@PKG@@'",
      prefixed("npm", "npm"),
      raw("pip3"),
      raw("cargo"),
      "echo '@@MEM@@'",
      darwin
        ? "(sysctl -n hw.memsize 2>/dev/null || true)"
        : "(grep MemTotal /proc/meminfo 2>/dev/null | awk '{print $2}' || true)",
    ].join(" && ")
    const proc = Bun.spawn(["sh", "-c", cmd], { stdout: "pipe", stderr: "pipe" })
    const timer = setTimeout(() => proc.kill(), 3000)
    const text = await new Response(proc.stdout).text()
    clearTimeout(timer)
    await proc.exited

    const sections: Record<string, string> = {}
    let key: string | undefined
    const lines: string[] = []
    for (const line of text.split("\n")) {
      if (line.startsWith("@@") && line.endsWith("@@")) {
        if (key) sections[key] = lines.join("\n")
        key = line.replaceAll("@", "")
        lines.length = 0
      } else {
        lines.push(line)
      }
    }
    if (key) sections[key] = lines.join("\n")

    const result: string[] = []

    const shell = sections.SHELL?.trim()
    if (shell) result.push(`  Shell: ${shell}`)

    const lang = sections.LANG?.trim()
    if (lang) {
      const items = lang
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.includes("not found") && !l.includes("No such file"))
      if (items.length) result.push(`  Languages: ${items.join("; ")}`)
    }

    const pkg = sections.PKG?.trim()
    if (pkg) {
      const items = pkg
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.includes("not found") && !l.includes("No such file"))
      if (items.length) result.push(`  Package managers: ${items.join("; ")}`)
    }

    const mem = sections.MEM?.trim()
    if (mem) {
      const bytes = parseInt(mem, 10)
      if (bytes > 0) {
        const gb = process.platform === "darwin" ? bytes / 1024 ** 3 : bytes / 1024 ** 2
        result.push(`  Memory: ${Math.round(gb)} GB`)
      }
    }

    cached = result
    return result
  } catch {
    cached = []
    return []
  }
}

export namespace SystemPrompt {
  export async function environment(input: {
    model: Provider.Model
    sessionID: string
    permission?: Permission.Ruleset
    interactive?: boolean
  }) {
    const project = Instance.project
    const restricted = input.permission
      ? Permission.evaluate("external_directory", "*", input.permission).action !== "allow"
      : false
    const perm = restricted ? " (read + write allowed)" : ""
    const snap = await snapshot()

    const lines = [
      `You are powered by the model named ${input.model.api.id}. The exact model ID is ${input.model.providerID}/${input.model.api.id}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}${perm}`,
      ...(Instance.worktree !== "/" && Instance.worktree !== Instance.directory
        ? [`  Workspace root folder: ${Instance.worktree}${perm}`]
        : []),
      ...(restricted
        ? [
            `  Temp workspace directory: ${getTmpdir(input.sessionID)}${perm} — use this instead of /tmp for temporary files`,
          ]
        : []),
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
      ...snap,
      `</env>`,
    ]

    if (restricted) {
      lines.push(
        input.interactive
          ? "Paths not described above require user permission to read or write. Only access them if needed."
          : "You do not have access to paths not described above. There is no way to request permission.",
      )
    }

    return [lines.join("\n")]
  }

  export function todos(agent: Agent.Info) {
    if (Permission.evaluate("todowrite", "*", agent.permission).action === "deny") return
    return `# Task Management

The todowrite tool is your plan, scratchpad, and progress record. Use it to externalize your reasoning: the \`notes\` field on each todo is where you record your plan, hypothesis, and observations so you can read them back on later turns.

## Tools that are free vs. gated
You can freely use read-only tools at any time, including:
- \`read_multimodal\`
- Read-only shell commands: ls, cat, head, tail, less, more, file, stat, find, grep, rg, awk, sed -n, wc, which, command -v, pwd, echo, tree, readelf, objdump, xxd, hexdump, od, git status, git log, git diff, git show, env, printenv, ps, uname, uptime, date.

Before using any shell command that changes state, you must have an active \`in_progress\` todo with populated \`notes\` describing your current plan. State-changing shell commands include:
- Creating or overwriting files (the \`write\` heredoc helper, redirections like \`>\` and \`>>\`, \`tee\`, \`cp\`, \`mv\`).
- Editing files (\`patch\`, \`sed -i\`).
- Any shell command not on the read-only list above (installs, builds, network calls, rm/mkdir/chmod, running scripts, package managers, etc.)

This gate lets you explore freely (ls, grep, file) to gather context, but forces you to commit to a plan before you do anything with side effects.

## Writing a good todo list
1. When you have enough context to plan (which is almost immediately on simple tasks, or after a few read-only commands on complex ones), call todowrite with 3–8 todos covering your milestones. Set one to \`in_progress\` and populate its \`notes\` with your immediate plan.
2. Every todo has THREE fields. All three are required:
   - \`content\`: short imperative title, one line.
   - \`status\`: \`pending\`, \`in_progress\`, \`completed\`, or \`cancelled\`. Exactly one item may be \`in_progress\` at a time.
   - \`notes\`: 1–5 sentences of working prose. For \`in_progress\` todos: your hypothesis, the specific commands/edits you are about to run, and the expected outcome. For \`completed\` todos: what you actually did and observed. For \`pending\` todos: a sketch of what you will do. For \`cancelled\` todos: one sentence on why. Never leave \`notes\` blank. Never write "TBD" or "see plan" — write the actual thought.
3. Before each chunk of side-effect work, update the \`in_progress\` todo's \`notes\` with what you are about to do. After each chunk, update the same todo's \`notes\` with what you observed. When done, mark it \`completed\` with a 1–2 sentence summary.
4. If the plan changes, add, re-word, or cancel todos to reflect the new plan.

## Enforcement
These rules are enforced by the runtime. You will receive a direct error message from the tool itself if you violate them:
- Any todo submitted with empty or trivially short \`notes\` is rejected.
- More than one \`in_progress\` todo at a time is rejected.
- Side-effect shell commands are blocked until you have an \`in_progress\` todo with populated notes.
- \`task_complete\` is blocked while any todo is \`pending\` or \`in_progress\`.

Keep the todo list current as you learn. Mark each todo \`completed\` immediately after finishing — do not batch completions.`
  }

  export async function skills(agent: Agent.Info) {
    if (Permission.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)
    if (!list.length) return

    return ["The following skills are available for specialized tasks.", Skill.fmt(list, { verbose: true })].join("\n")
  }
}
