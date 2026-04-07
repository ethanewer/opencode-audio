import { PlanExitTool } from "./plan"
import { QuestionTool } from "./question"
import { EditTool } from "./edit"
import { ReadTool } from "./read"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { ProviderID, type ModelID } from "../provider/schema"
import { evaluate } from "@/permission/evaluate"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { Truncate } from "./truncate"
import { ApplyPatchTool } from "./apply_patch"
import { TranscribeTool } from "./transcribe"
import { ReadAudioTool } from "./read_audio"
import { SpeakTool } from "./speak"
import { EvalRebuttalTool, EvalTool } from "./eval"
import { ExecuteCommandsTool } from "./execute_commands"
import { TaskCompleteTool } from "./task_complete"
import { TaskTool } from "./task"
import { Glob } from "../util/glob"
import { pathToFileURL } from "url"
import { Effect, Layer, ServiceMap } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { makeRuntime } from "@/effect/run-service"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  type State = {
    custom: Tool.Info[]
  }

  export interface Interface {
    readonly register: (tool: Tool.Info) => Effect.Effect<void>
    readonly ids: () => Effect.Effect<string[]>
    readonly tools: (
      model: {
        providerID: ProviderID
        modelID: ModelID
        audioInput?: boolean
        audioOutput?: boolean
        imageInput?: boolean
        pdfInput?: boolean
        hasVisionModel?: boolean
      },
      agent?: Agent.Info,
    ) => Effect.Effect<(Tool.Def & { id: string })[]>
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/ToolRegistry") {}

  export const layer: Layer.Layer<Service, never, Config.Service | Plugin.Service> = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* Config.Service
      const plugin = yield* Plugin.Service

      const cache = yield* InstanceState.make<State>(
        Effect.fn("ToolRegistry.state")(function* (ctx) {
          const custom: Tool.Info[] = []

          function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
            return {
              id,
              init: async (initCtx) => ({
                parameters: z.object(def.args),
                description: def.description,
                execute: async (args, toolCtx) => {
                  const pluginCtx = {
                    ...toolCtx,
                    directory: ctx.directory,
                    worktree: ctx.worktree,
                  } as unknown as PluginToolContext
                  const result = await def.execute(args as any, pluginCtx)
                  const out = await Truncate.output(result, {}, initCtx?.agent)
                  return {
                    title: "",
                    output: out.truncated ? out.content : result,
                    metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
                  }
                },
              }),
            }
          }

          const dirs = yield* config.directories()
          const matches = dirs.flatMap((dir) =>
            Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
          )
          if (matches.length) yield* config.waitForDependencies()
          for (const match of matches) {
            const namespace = path.basename(match, path.extname(match))
            const mod = yield* Effect.promise(
              () => import(process.platform === "win32" ? match : pathToFileURL(match).href),
            )
            for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
              custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
            }
          }

          const plugins = yield* plugin.list()
          for (const p of plugins) {
            for (const [id, def] of Object.entries(p.tool ?? {})) {
              custom.push(fromPlugin(id, def))
            }
          }

          return { custom }
        }),
      )

      const all = Effect.fn("ToolRegistry.all")(function* (custom: Tool.Info[]) {
        const question = ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

        return [
          InvalidTool,
          ...(question ? [QuestionTool] : []),
          ReadTool,
          EditTool,
          WriteTool,
          ApplyPatchTool,
          TranscribeTool,
          ReadAudioTool,
          SpeakTool,
          EvalTool,
          EvalRebuttalTool,
          ExecuteCommandsTool,
          TaskCompleteTool,
          TaskTool,
          ...(Flag.OPENCODE_CLIENT === "cli" ? [PlanExitTool] : []),
          ...custom,
        ]
      })

      const register = Effect.fn("ToolRegistry.register")(function* (tool: Tool.Info) {
        const state = yield* InstanceState.get(cache)
        const idx = state.custom.findIndex((t) => t.id === tool.id)
        if (idx >= 0) {
          state.custom.splice(idx, 1, tool)
          return
        }
        state.custom.push(tool)
      })

      const ids = Effect.fn("ToolRegistry.ids")(function* () {
        const state = yield* InstanceState.get(cache)
        const tools = yield* all(state.custom)
        return tools.map((t) => t.id)
      })

      const tools = Effect.fn("ToolRegistry.tools")(function* (
        model: {
          providerID: ProviderID
          modelID: ModelID
          audioInput?: boolean
          audioOutput?: boolean
          imageInput?: boolean
          pdfInput?: boolean
          hasVisionModel?: boolean
        },
        agent?: Agent.Info,
      ) {
        const state = yield* InstanceState.get(cache)
        const allTools = yield* all(state.custom)
        const voice = agent?.name.startsWith("voice-") ?? false
        const filtered = allTools.filter((tool) => {
          if (tool.id === "plan_exit") {
            return Flag.OPENCODE_CLIENT === "cli" && (agent?.name === "plan" || agent?.name === "voice-plan")
          }

          if (tool.id === "eval_result") {
            return agent?.name === "eval"
          }

          if (tool.id === "eval_rebuttal") {
            return agent?.name !== "eval"
          }

          if (tool.id === "task") {
            if (!agent?.permission) return false
            return evaluate("task", "*", agent.permission).action !== "deny"
          }

          if (tool.id === "task_complete") {
            if (!agent?.permission) return false
            return evaluate("task_complete", "*", agent.permission).action !== "deny"
          }

          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (tool.id === "apply_patch") return usePatch
          if (tool.id === "edit" || tool.id === "write") return !usePatch

          if (tool.id === "read_audio") return model.audioInput === true
          if (tool.id === "transcribe") return model.audioInput !== true

          if (tool.id === "speak") return voice && model.audioOutput !== true
          if (tool.id === "question") return !voice

          return true
        })
        return yield* Effect.forEach(
          filtered,
          Effect.fnUntraced(function* (tool: Tool.Info) {
            using _ = log.time(tool.id)
            const next = yield* Effect.promise(() =>
              tool.init({
                agent,
                capabilities: {
                  imageInput: model.imageInput,
                  audioInput: model.audioInput,
                  pdfInput: model.pdfInput,
                  hasVisionModel: model.hasVisionModel,
                  hasTranscription: true,
                },
              }),
            )
            const output = {
              description: next.description,
              parameters: next.parameters,
            }
            yield* plugin.trigger("tool.definition", { toolID: tool.id }, output)
            return {
              id: tool.id,
              description: output.description,
              parameters: output.parameters,
              execute: next.execute,
              formatValidationError: next.formatValidationError,
            }
          }),
          { concurrency: "unbounded" },
        )
      })

      return Service.of({ register, ids, tools })
    }),
  )

  export const defaultLayer = Layer.unwrap(
    Effect.sync(() => layer.pipe(Layer.provide(Config.defaultLayer), Layer.provide(Plugin.defaultLayer))),
  )

  const { runPromise } = makeRuntime(Service, defaultLayer)

  export async function register(tool: Tool.Info) {
    return runPromise((svc) => svc.register(tool))
  }

  export async function ids() {
    return runPromise((svc) => svc.ids())
  }

  export async function tools(
    model: {
      providerID: ProviderID
      modelID: ModelID
      audioInput?: boolean
      audioOutput?: boolean
      imageInput?: boolean
      pdfInput?: boolean
    },
    agent?: Agent.Info,
  ): Promise<(Tool.Def & { id: string })[]> {
    return runPromise((svc) => svc.tools(model, agent))
  }
}
