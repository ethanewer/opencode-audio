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
      ...(restricted ? [`  Temp workspace directory: ${getTmpdir(input.sessionID)}${perm}`] : []),
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

  export async function skills(agent: Agent.Info) {
    if (Permission.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)
    if (!list.length) return

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }
}
