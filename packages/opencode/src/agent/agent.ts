import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncate"
import { GLOB as TmpdirGlob } from "../session/tmpdir"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_EVAL from "./prompt/eval.txt"
import PROMPT_PLAN from "./prompt/plan.txt"
import PROMPT_EXTRACT from "./prompt/extract.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import PROMPT_TASK from "../session/prompt/task.txt"
import PROMPT_VOICE_TASK from "../session/prompt/voice-task.txt"
import { Permission } from "@/permission"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"
import { Effect, ServiceMap, Layer } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"

export namespace Agent {
  export const Info = z
    .object({
      name: z.string(),
      description: z.string().optional(),
      mode: z.enum(["subagent", "primary", "all"]),
      native: z.boolean().optional(),
      hidden: z.boolean().optional(),
      topP: z.number().optional(),
      temperature: z.number().optional(),
      color: z.string().optional(),
      permission: Permission.Ruleset,
      model: z
        .object({
          modelID: ModelID.zod,
          providerID: ProviderID.zod,
        })
        .optional(),
      variant: z.string().optional(),
      prompt: z.string().optional(),
      options: z.record(z.string(), z.any()),
      steps: z.number().int().positive().optional(),
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  export interface Interface {
    readonly get: (agent: string) => Effect.Effect<Agent.Info>
    readonly list: () => Effect.Effect<Agent.Info[]>
    readonly defaultAgent: () => Effect.Effect<string>
    readonly generate: (input: {
      description: string
      model?: { providerID: ProviderID; modelID: ModelID }
    }) => Effect.Effect<{
      identifier: string
      whenToUse: string
      systemPrompt: string
    }>
  }

  type State = Omit<Interface, "generate">

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Agent") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const auth = yield* Auth.Service
      const skill = yield* Skill.Service

      const state = yield* InstanceState.make<State>(
        Effect.fn("Agent.state")(function* (ctx) {
          const cfg = yield* config.get()
          const skillDirs = yield* skill.dirs()
          const whitelistedDirs = [Truncate.GLOB, TmpdirGlob, ...skillDirs.map((dir) => path.join(dir, "*"))]

          const defaults = Permission.fromConfig({
            "*": "allow",
            task: "deny",
            task_complete: "deny",
            doom_loop: "ask",
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
            question: "deny",
            plan_enter: "deny",
            plan_exit: "deny",
            // mirrors github.com/github/gitignore Node.gitignore pattern for .env files
            read: {
              "*": "allow",
              "*.env": "ask",
              "*.env.*": "ask",
              "*.env.example": "allow",
            },
          })

          const user = Permission.fromConfig(cfg.permission ?? {})

          const agents: Record<string, Info> = {
            build: {
              name: "build",
              description: "The default agent. Executes tools based on configured permissions.",
              prompt: PROMPT_TASK,
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  question: "allow",
                  plan_enter: "allow",
                  task_complete: "allow",
                }),
                user,
              ),
              mode: "primary",
              native: true,
              color: "info",
            },
            plan: {
              name: "plan",
              description: "Plan mode. Disallows all edit tools. Shell commands restricted to read-only operations.",
              prompt: PROMPT_PLAN,
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  // deny all unknown permissions (blocks MCP tools)
                  "*": "deny",
                  // re-allow permissions only in defaults
                  execute_commands: "allow",
                  read: {
                    "*": "allow",
                    "*.env": "ask",
                    "*.env.*": "ask",
                    "*.env.example": "allow",
                  },
                  webfetch: "allow",
                  speak: "allow",
                  doom_loop: "ask",
                  question: "allow",
                  plan_exit: "allow",
                  task: {
                    "*": "deny",
                    explore: "allow",
                    general: "allow",
                  },
                  external_directory: {
                    [path.join(Global.Path.data, "plans", "*")]: "allow",
                  },
                  edit: {
                    "*": "deny",
                    [path.join(".opencode", "plans", "*.md")]: "allow",
                    [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]:
                      "allow",
                  },
                  bash: {
                    "*": "deny",
                    "grep *": "allow",
                    "rg *": "allow",
                    "find *": "allow",
                    "cat *": "allow",
                    "ls *": "allow",
                    "head *": "allow",
                    "tail *": "allow",
                    "wc *": "allow",
                    "sort *": "allow",
                    "uniq *": "allow",
                    "diff *": "allow",
                    "file *": "allow",
                    "stat *": "allow",
                    "du *": "allow",
                    "tree *": "allow",
                    "pwd *": "allow",
                    "which *": "allow",
                    "printenv *": "allow",
                    "jq *": "allow",
                    "cut *": "allow",
                    "tr *": "allow",
                    // git: allow all, then deny destructive subcommands
                    "git *": "allow",
                    "git -c *": "deny",
                    "git add *": "deny",
                    "git am *": "deny",
                    "git apply *": "deny",
                    "git bisect *": "deny",
                    "git checkout *": "deny",
                    "git cherry-pick *": "deny",
                    "git clean *": "deny",
                    "git clone *": "deny",
                    "git commit *": "deny",
                    "git config *": "deny",
                    "git filter-branch *": "deny",
                    "git gc *": "deny",
                    "git init *": "deny",
                    "git maintenance *": "deny",
                    "git merge *": "deny",
                    "git mv *": "deny",
                    "git notes add *": "deny",
                    "git notes append *": "deny",
                    "git notes edit *": "deny",
                    "git notes merge *": "deny",
                    "git notes remove *": "deny",
                    "git notes prune *": "deny",
                    "git pack-refs *": "deny",
                    "git prune *": "deny",
                    "git pull *": "deny",
                    "git push *": "deny",
                    "git rebase *": "deny",
                    "git reflog expire *": "deny",
                    "git reflog delete *": "deny",
                    "git repack *": "deny",
                    "git replace *": "deny",
                    "git reset *": "deny",
                    "git restore *": "deny",
                    "git revert *": "deny",
                    "git rm *": "deny",
                    "git sparse-checkout *": "deny",
                    "git stash *": "deny",
                    "git submodule update *": "deny",
                    "git submodule init *": "deny",
                    "git submodule add *": "deny",
                    "git submodule deinit *": "deny",
                    "git switch *": "deny",
                    "git tag *": "deny",
                    "git update-index *": "deny",
                    "git update-ref *": "deny",
                    "git worktree *": "deny",
                    // re-allow safe read-only subcommands
                    "git stash list *": "allow",
                    "git stash show *": "allow",
                    "git tag -l *": "allow",
                    "git tag --list *": "allow",
                    "git reflog show *": "allow",
                    "git reflog list *": "allow",
                    "git notes list *": "allow",
                    "git submodule status *": "allow",
                    "git submodule summary *": "allow",
                    "git worktree list *": "allow",
                    "git config --list *": "allow",
                    "git config -l *": "allow",
                    "git config --get *": "allow",
                    "git config --get-all *": "allow",
                    "git config --get-regexp *": "allow",
                    // deny dangerous find flags
                    "find * -exec *": "deny",
                    "find * -execdir *": "deny",
                    "find * -delete *": "deny",
                    "find * -ok *": "deny",
                    "find * -okdir *": "deny",
                    // deny sort file writing
                    "sort -o *": "deny",
                    "sort --output *": "deny",
                    // deny output redirections
                    "* > *": "deny",
                    "* >> *": "deny",
                  },
                }),
                user,
              ),
              mode: "primary",
              native: true,
              color: "success",
            },
            auto: {
              name: "auto",
              description: "Autonomous mode. Plans, builds, and evaluates automatically.",
              prompt: PROMPT_TASK,
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  question: "allow",
                  plan_enter: "allow",
                  task_complete: "allow",
                }),
                user,
              ),
              mode: "primary",
              native: true,
              color: "secondary",
            },
            "voice-build": {
              name: "voice-build",
              description: "Voice build agent. Same as build but responses are optimized for text-to-speech output.",
              prompt: PROMPT_VOICE_TASK,
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  plan_enter: "allow",
                  voice_complete: "allow",
                  native_voice_complete: "allow",
                }),
                user,
              ),
              mode: "primary",
              native: true,
              hidden: true,
              color: "info",
            },
            "voice-plan": {
              name: "voice-plan",
              description: "Voice plan agent. Same as plan but responses are optimized for text-to-speech output.",
              prompt: PROMPT_PLAN,
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  // deny all unknown permissions (blocks MCP tools)
                  "*": "deny",
                  // re-allow permissions only in defaults
                  execute_commands: "allow",
                  read: {
                    "*": "allow",
                    "*.env": "ask",
                    "*.env.*": "ask",
                    "*.env.example": "allow",
                  },
                  webfetch: "allow",
                  speak: "allow",
                  doom_loop: "ask",
                  plan_exit: "allow",
                  task: {
                    "*": "deny",
                    explore: "allow",
                    general: "allow",
                  },
                  external_directory: {
                    [path.join(Global.Path.data, "plans", "*")]: "allow",
                  },
                  edit: {
                    "*": "deny",
                    [path.join(".opencode", "plans", "*.md")]: "allow",
                    [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]:
                      "allow",
                  },
                  bash: {
                    "*": "deny",
                    "grep *": "allow",
                    "rg *": "allow",
                    "find *": "allow",
                    "cat *": "allow",
                    "ls *": "allow",
                    "head *": "allow",
                    "tail *": "allow",
                    "wc *": "allow",
                    "sort *": "allow",
                    "uniq *": "allow",
                    "diff *": "allow",
                    "file *": "allow",
                    "stat *": "allow",
                    "du *": "allow",
                    "tree *": "allow",
                    "pwd *": "allow",
                    "which *": "allow",
                    "printenv *": "allow",
                    "jq *": "allow",
                    "cut *": "allow",
                    "tr *": "allow",
                    // git: allow all, then deny destructive subcommands
                    "git *": "allow",
                    "git -c *": "deny",
                    "git add *": "deny",
                    "git am *": "deny",
                    "git apply *": "deny",
                    "git bisect *": "deny",
                    "git checkout *": "deny",
                    "git cherry-pick *": "deny",
                    "git clean *": "deny",
                    "git clone *": "deny",
                    "git commit *": "deny",
                    "git config *": "deny",
                    "git filter-branch *": "deny",
                    "git gc *": "deny",
                    "git init *": "deny",
                    "git maintenance *": "deny",
                    "git merge *": "deny",
                    "git mv *": "deny",
                    "git notes add *": "deny",
                    "git notes append *": "deny",
                    "git notes edit *": "deny",
                    "git notes merge *": "deny",
                    "git notes remove *": "deny",
                    "git notes prune *": "deny",
                    "git pack-refs *": "deny",
                    "git prune *": "deny",
                    "git pull *": "deny",
                    "git push *": "deny",
                    "git rebase *": "deny",
                    "git reflog expire *": "deny",
                    "git reflog delete *": "deny",
                    "git repack *": "deny",
                    "git replace *": "deny",
                    "git reset *": "deny",
                    "git restore *": "deny",
                    "git revert *": "deny",
                    "git rm *": "deny",
                    "git sparse-checkout *": "deny",
                    "git stash *": "deny",
                    "git submodule update *": "deny",
                    "git submodule init *": "deny",
                    "git submodule add *": "deny",
                    "git submodule deinit *": "deny",
                    "git switch *": "deny",
                    "git tag *": "deny",
                    "git update-index *": "deny",
                    "git update-ref *": "deny",
                    "git worktree *": "deny",
                    // re-allow safe read-only subcommands
                    "git stash list *": "allow",
                    "git stash show *": "allow",
                    "git tag -l *": "allow",
                    "git tag --list *": "allow",
                    "git reflog show *": "allow",
                    "git reflog list *": "allow",
                    "git notes list *": "allow",
                    "git submodule status *": "allow",
                    "git submodule summary *": "allow",
                    "git worktree list *": "allow",
                    "git config --list *": "allow",
                    "git config -l *": "allow",
                    "git config --get *": "allow",
                    "git config --get-all *": "allow",
                    "git config --get-regexp *": "allow",
                    // deny dangerous find flags
                    "find * -exec *": "deny",
                    "find * -execdir *": "deny",
                    "find * -delete *": "deny",
                    "find * -ok *": "deny",
                    "find * -okdir *": "deny",
                    // deny sort file writing
                    "sort -o *": "deny",
                    "sort --output *": "deny",
                    // deny output redirections
                    "* > *": "deny",
                    "* >> *": "deny",
                  },
                }),
                user,
              ),
              mode: "primary",
              native: true,
              hidden: true,
              color: "success",
            },
            general: {
              name: "general",
              description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
              prompt: PROMPT_TASK,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  task: "allow",
                  todowrite: "deny",
                }),
                user,
              ),
              options: {},
              mode: "subagent",
              native: true,
            },
            explore: {
              name: "explore",
              description: `Fast agent specialized for exploring codebases. Use this when you need to find files, search code, or answer questions about the codebase. Specify thoroughness: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis.`,
              prompt: PROMPT_TASK,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                  execute_commands: "allow",
                  read: "allow",
                  bash: {
                    "*": "deny",
                    "grep *": "allow",
                    "rg *": "allow",
                    "find *": "allow",
                    "cat *": "allow",
                    "ls *": "allow",
                    "head *": "allow",
                    "tail *": "allow",
                    "wc *": "allow",
                    "sort *": "allow",
                    "uniq *": "allow",
                    "diff *": "allow",
                    "file *": "allow",
                    "stat *": "allow",
                    "du *": "allow",
                    "tree *": "allow",
                    "pwd *": "allow",
                    "echo *": "allow",
                    "git *": "allow",
                    "which *": "allow",
                    "env *": "allow",
                    "awk *": "allow",
                    "jq *": "allow",
                    "cut *": "allow",
                    "tr *": "allow",
                  },
                  external_directory: {
                    "*": "ask",
                    ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
                  },
                }),
                user,
              ),
              options: {},
              mode: "subagent",
              native: true,
            },
            compaction: {
              name: "compaction",
              mode: "primary",
              native: true,
              hidden: true,
              prompt: PROMPT_COMPACTION,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              options: {},
            },
            title: {
              name: "title",
              mode: "primary",
              options: {},
              native: true,
              hidden: true,
              temperature: 0.5,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              prompt: PROMPT_TITLE,
            },
            summary: {
              name: "summary",
              mode: "primary",
              options: {},
              native: true,
              hidden: true,
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              prompt: PROMPT_SUMMARY,
            },
            eval: {
              name: "eval",
              description: "Evaluation agent. Reviews build output for correctness and completeness.",
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  edit: "deny",
                  task: "deny",
                  todowrite: "deny",
                }),
                user,
              ),
              prompt: PROMPT_EVAL,
              mode: "primary",
              native: true,
              hidden: true,
            },
            extract: {
              name: "extract",
              description: "Instruction extraction agent. Summarizes user intent from conversation history.",
              options: {},
              permission: Permission.merge(
                defaults,
                Permission.fromConfig({
                  "*": "deny",
                }),
                user,
              ),
              prompt: PROMPT_EXTRACT,
              mode: "primary",
              native: true,
              hidden: true,
            },
          }

          for (const [key, value] of Object.entries(cfg.agent ?? {})) {
            if (value.disable) {
              delete agents[key]
              continue
            }
            let item = agents[key]
            if (!item)
              item = agents[key] = {
                name: key,
                mode: "all",
                permission: Permission.merge(defaults, user),
                options: {},
                native: false,
              }
            if (value.model) item.model = Provider.parseModel(value.model)
            item.variant = value.variant ?? item.variant
            item.prompt = value.prompt ?? item.prompt
            item.description = value.description ?? item.description
            item.temperature = value.temperature ?? item.temperature
            item.topP = value.top_p ?? item.topP
            item.mode = value.mode ?? item.mode
            item.color = value.color ?? item.color
            item.hidden = value.hidden ?? item.hidden
            item.name = value.name ?? item.name
            item.steps = value.steps ?? item.steps
            item.options = mergeDeep(item.options, value.options ?? {})
            item.permission = Permission.merge(item.permission, Permission.fromConfig(value.permission ?? {}))
          }

          // Ensure Truncate.GLOB is allowed unless explicitly configured
          for (const name in agents) {
            const agent = agents[name]
            const explicit = agent.permission.some((r) => {
              if (r.permission !== "external_directory") return false
              if (r.action !== "deny") return false
              return r.pattern === Truncate.GLOB
            })
            if (explicit) continue

            agents[name].permission = Permission.merge(
              agents[name].permission,
              Permission.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
            )
          }

          const get = Effect.fnUntraced(function* (agent: string) {
            return agents[agent]
          })

          const list = Effect.fnUntraced(function* () {
            const cfg = yield* config.get()
            return pipe(
              agents,
              values(),
              sortBy(
                [(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"],
                [(x) => x.name, "asc"],
              ),
            )
          })

          const defaultAgent = Effect.fnUntraced(function* () {
            const c = yield* config.get()
            if (c.default_agent) {
              const agent = agents[c.default_agent]
              if (!agent) throw new Error(`default agent "${c.default_agent}" not found`)
              if (agent.mode === "subagent") throw new Error(`default agent "${c.default_agent}" is a subagent`)
              if (agent.hidden === true) throw new Error(`default agent "${c.default_agent}" is hidden`)
              return agent.name
            }
            const visible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
            if (!visible) throw new Error("no primary visible agent found")
            return visible.name
          })

          return {
            get,
            list,
            defaultAgent,
          } satisfies State
        }),
      )

      return Service.of({
        get: Effect.fn("Agent.get")(function* (agent: string) {
          return yield* InstanceState.useEffect(state, (s) => s.get(agent))
        }),
        list: Effect.fn("Agent.list")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.list())
        }),
        defaultAgent: Effect.fn("Agent.defaultAgent")(function* () {
          return yield* InstanceState.useEffect(state, (s) => s.defaultAgent())
        }),
        generate: Effect.fn("Agent.generate")(function* (input: {
          description: string
          model?: { providerID: ProviderID; modelID: ModelID }
        }) {
          const cfg = yield* config.get()
          const model = input.model ?? (yield* Effect.promise(() => Provider.defaultModel()))
          const resolved = yield* Effect.promise(() => Provider.getModel(model.providerID, model.modelID))
          const language = yield* Effect.promise(() => Provider.getLanguage(resolved))

          const system = [PROMPT_GENERATE]
          yield* Effect.promise(() =>
            Plugin.trigger("experimental.chat.system.transform", { model: resolved }, { system }),
          )
          const existing = yield* InstanceState.useEffect(state, (s) => s.list())

          const params = {
            experimental_telemetry: {
              isEnabled: cfg.experimental?.openTelemetry,
              metadata: {
                userId: cfg.username ?? "unknown",
              },
            },
            temperature: 0.3,
            messages: [
              ...system.map(
                (item): ModelMessage => ({
                  role: "system",
                  content: item,
                }),
              ),
              {
                role: "user",
                content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
              },
            ],
            model: language,
            schema: z.object({
              identifier: z.string(),
              whenToUse: z.string(),
              systemPrompt: z.string(),
            }),
          } satisfies Parameters<typeof generateObject>[0]

          // TODO: clean this up so provider specific logic doesnt bleed over
          const authInfo = yield* auth.get(model.providerID).pipe(Effect.orDie)
          if (model.providerID === "openai" && authInfo?.type === "oauth") {
            return yield* Effect.promise(async () => {
              const result = streamObject({
                ...params,
                providerOptions: ProviderTransform.providerOptions(resolved, {
                  store: false,
                }),
                onError: () => {},
              })
              for await (const part of result.fullStream) {
                if (part.type === "error") throw part.error
              }
              return result.object
            })
          }

          return yield* Effect.promise(() => generateObject(params).then((r) => r.object))
        }),
      })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Skill.defaultLayer),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function get(agent: string) {
    return runPromise((svc) => svc.get(agent))
  }

  export async function list() {
    return runPromise((svc) => svc.list())
  }

  export async function defaultAgent() {
    return runPromise((svc) => svc.defaultAgent())
  }

  export async function generate(input: { description: string; model?: { providerID: ProviderID; modelID: ModelID } }) {
    return runPromise((svc) => svc.generate(input))
  }
}
