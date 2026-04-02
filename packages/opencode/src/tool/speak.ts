import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./speak.txt"
import { Config } from "../config/config"
import * as Speaker from "../audio/speaker"

export const SpeakTool = Tool.define("speak", {
  description: DESCRIPTION,
  parameters: z.object({
    text: z.string().describe("The text to speak aloud to the user"),
  }),
  async execute(params) {
    const cfg = await Config.get()
    const speed = cfg.experimental?.voice?.tts?.speed ?? 1
    const rem = Speaker.remaining(speed)

    if (rem > 1) {
      throw new Error(
        `Already speaking. Approximately ${rem.toFixed(1)} seconds remaining. Wait before calling speak again.`,
      )
    }

    Speaker.submit(params.text, speed)

    return {
      title: "speak",
      output: rem > 0 ? "Queued." : "Speaking.",
      metadata: { truncated: false },
    }
  },
})
