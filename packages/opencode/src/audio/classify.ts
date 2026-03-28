import { generateObject } from "ai"
import type { LanguageModelV2 } from "@ai-sdk/provider"
import z from "zod"

const schema = z.object({
  option: z.string().nullable().describe("The option the user most likely meant, or null if unclear"),
  confidence: z
    .enum(["0", "0.25", "0.5", "0.75", "1"])
    .describe("How confident you are: 0 = completely unsure, 1 = very confident"),
})

export async function classify(model: LanguageModelV2, transcript: string, options: string[], question?: string) {
  const result = await generateObject({
    model,
    schema,
    system: [
      "You are classifying a voice transcript into one of the given options.",
      "The user spoke their answer aloud and it was transcribed. Match their intent to the closest option.",
      "Return null for option and '0' for confidence if the transcript is unclear or unrelated to any option.",
      "Return '1' for confidence only when the match is unambiguous.",
      "The option field must be exactly one of the provided option strings, or null.",
    ].join(" "),
    prompt: [question ? `Question: ${question}` : "", `Options: ${options.join(", ")}`, `User said: "${transcript}"`]
      .filter(Boolean)
      .join("\n"),
  })
  const option = result.object.option
  return {
    option: option && options.includes(option) ? option : null,
    confidence: parseFloat(result.object.confidence),
  }
}
