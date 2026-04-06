import { Ripgrep } from "../file/ripgrep"
import { execSync } from "child_process"

import { Instance } from "../project/instance"

import PROMPT_ANTHROPIC from "./prompt/anthropic.txt"
import PROMPT_DEFAULT from "./prompt/default.txt"
import PROMPT_BEAST from "./prompt/beast.txt"
import PROMPT_GEMINI from "./prompt/gemini.txt"
import PROMPT_GPT from "./prompt/gpt.txt"
import PROMPT_KIMI from "./prompt/kimi.txt"

import PROMPT_CODEX from "./prompt/codex.txt"
import PROMPT_TRINITY from "./prompt/trinity.txt"
import type { Provider } from "@/provider/provider"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Skill } from "@/skill"

function probe(cmd: string): string | undefined {
  try {
    return execSync(cmd, { timeout: 3000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf-8" }).trim()
  } catch {
    return undefined
  }
}

function which(name: string): boolean {
  return probe(`command -v ${name}`) !== undefined
}

let _toolInfo: string | undefined
function discoverTools(): string {
  if (_toolInfo !== undefined) return _toolInfo
  const items: string[] = []
  const py = probe("python3 --version") || probe("python --version")
  if (py) items.push(`Python: ${py.replace("Python ", "")}`)
  const node = probe("node --version")
  if (node) items.push(`Node: ${node.replace("v", "")}`)
  const mgrs: string[] = []
  for (const m of ["uv", "pip", "pip3", "npm", "pnpm", "yarn", "bun"]) {
    if (which(m)) mgrs.push(m)
  }
  if (mgrs.length) items.push(`Package managers: ${mgrs.join(", ")}`)
  const build: string[] = []
  for (const b of ["gcc", "g++", "make", "cmake", "cargo", "go", "javac", "rustc"]) {
    if (which(b)) build.push(b)
  }
  if (build.length) items.push(`Build tools: ${build.join(", ")}`)
  const other: string[] = []
  for (const t of ["docker", "git", "curl", "wget", "jq", "tar", "unzip"]) {
    if (which(t)) other.push(t)
  }
  if (other.length) items.push(`Utilities: ${other.join(", ")}`)
  _toolInfo = items.length ? items.join("\n  ") : ""
  return _toolInfo
}

export namespace SystemPrompt {
  export function provider(model: Provider.Model) {
    if (model.api.id.includes("gpt-4") || model.api.id.includes("o1") || model.api.id.includes("o3"))
      return [PROMPT_BEAST]
    if (model.api.id.includes("gpt")) {
      if (model.api.id.includes("codex")) {
        return [PROMPT_CODEX]
      }
      return [PROMPT_GPT]
    }
    if (model.api.id.includes("gemini-")) return [PROMPT_GEMINI]
    if (model.api.id.includes("claude")) return [PROMPT_ANTHROPIC]
    if (model.api.id.toLowerCase().includes("trinity")) return [PROMPT_TRINITY]
    if (model.api.id.toLowerCase().includes("kimi")) return [PROMPT_KIMI]
    return [PROMPT_DEFAULT]
  }

  export async function environment(model: Provider.Model) {
    const project = Instance.project
    const tools = discoverTools()
    const envLines = [
      `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
      `Here is some useful information about the environment you are running in:`,
      `<env>`,
      `  Working directory: ${Instance.directory}`,
      `  Workspace root folder: ${Instance.worktree}`,
      `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Today's date: ${new Date().toDateString()}`,
    ]
    if (tools) {
      envLines.push(`  <tools>`)
      envLines.push(`  ${tools}`)
      envLines.push(`  </tools>`)
    }
    envLines.push(`</env>`)
    return [envLines.join("\n")]
  }

  export async function skills(agent: Agent.Info) {
    if (Permission.disabled(["skill"], agent.permission).has("skill")) return

    const list = await Skill.available(agent)

    return [
      "Skills provide specialized instructions and workflows for specific tasks.",
      "Use the skill tool to load a skill when a task matches its description.",
      Skill.fmt(list, { verbose: true }),
    ].join("\n")
  }
}
