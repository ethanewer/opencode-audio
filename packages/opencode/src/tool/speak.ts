import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./speak.txt"
import { Config } from "../config/config"
import * as Speaker from "../audio/speaker"

export const SpeakTool = Tool.define("speak", {
  description: DESCRIPTION,
  parameters: z.object({
    text: z.string().describe("The text to speak aloud to the user"),
    wait: z.boolean().optional().describe("Set true when asking a question. Pauses until the user responds."),
  }),
  async execute(params) {
    const cfg = await Config.get()
    const speed = cfg.experimental?.voice?.tts?.speed ?? 1

    if (Speaker.isBusy()) {
      const rem = Speaker.remaining(speed)
      throw new Error(
        `Already speaking. Approximately ${rem.toFixed(1)} seconds remaining. Wait before calling speak again.`,
      )
    }

    Speaker.submit(params.text, speed)

    return {
      title: "speak",
      output: params.wait ? "Speaking. Waiting for user response." : "Speaking.",
      metadata: { truncated: false, wait: params.wait === true },
    }
  },
})
