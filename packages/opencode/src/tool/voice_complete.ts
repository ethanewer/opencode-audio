import z from "zod"
import { Tool } from "./tool"
import { TaskComplete } from "./task_complete"
import { Config } from "../config/config"
import * as Speaker from "../audio/speaker"

export const VoiceCompleteTool = Tool.define(
  "voice_complete",
  {
    description:
      "Call this when you have finished the user's request. The text parameter is the final message to be spoken to the user.",
    parameters: z.object({
      text: z.string().describe("The final message to speak to the user"),
    }),
    async execute(params, ctx) {
      const cfg = await Config.get()
      const speed = cfg.experimental?.voice?.tts?.speed ?? 1

      if (Speaker.isBusy()) {
        const rem = Speaker.remaining(speed)
        throw new Error(
          `Already speaking. Approximately ${rem.toFixed(1)} seconds remaining. Wait before calling task_complete again.`,
        )
      }

      Speaker.submit(params.text, speed)
      TaskComplete.confirm(ctx.sessionID)

      return {
        title: "Task complete",
        metadata: {},
        output: "Task confirmed complete.",
      }
    },
  },
  "task_complete",
)

export const NativeVoiceCompleteTool = Tool.define(
  "native_voice_complete",
  {
    description: "Call this when you have finished the user's request.",
    parameters: z.object({}),
    async execute(_params, ctx) {
      TaskComplete.confirm(ctx.sessionID)

      return {
        title: "Task complete",
        metadata: {},
        output: "Task confirmed complete.",
      }
    },
  },
  "task_complete",
)
