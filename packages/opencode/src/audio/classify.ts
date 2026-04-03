import { generateObject } from "ai"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import z from "zod"

const schema = z.object({
  option: z.string().nullable().describe("The option the user most likely meant, or null if unclear"),
  context: z
    .string()
    .nullable()
    .describe(
      "Any additional context, instructions, or reasoning the user expressed beyond their option choice, or null if none",
    ),
  confidence: z
    .enum(["0", "0.25", "0.5", "0.75", "1"])
    .describe("How confident you are: 0 = completely unsure, 1 = very confident"),
})

export async function classify(model: LanguageModelV3, transcript: string, options: string[], question?: string) {
  const result = await generateObject({
    model,
    schema,
    system: [
      "You are classifying a voice transcript into one of the given options.",
      "The user spoke their answer aloud and it was transcribed. Match their intent to the closest option.",
      "Return null for option and '0' for confidence if the transcript is unclear or unrelated to any option.",
      "Return '1' for confidence only when the match is unambiguous.",
      "The option field must be exactly one of the provided option strings, or null.",
      "",
      "CONTEXT EXTRACTION:",
      "If the user expressed additional context, instructions, feedback, or reasoning beyond just picking an option, extract that into the context field.",
      "Preserve the user's meaning faithfully — do not omit details, do not add interpretation.",
      "Return null for context if the user only indicated their choice with no extra information.",
      "",
      "GOOD examples:",
      '- User: "No, I want you to use OAuth instead of basic auth" → option: negative choice, context: "I want you to use OAuth instead of basic auth"',
      '- User: "Yes but skip the database migration step" → option: affirmative choice, context: "skip the database migration step"',
      '- User: "Keep planning, the error handling needs to cover timeout errors and retry logic" → option: "Keep planning", context: "the error handling needs to cover timeout errors and retry logic"',
      '- User: "Yeah that looks good" → option: affirmative choice, context: null',
      '- User: "No" → option: negative choice, context: null',
      "",
      "BAD examples (do NOT do these):",
      "- Do NOT return context: null when the user clearly gave extra instructions beyond their choice.",
      '- Do NOT paraphrase loosely — "use OAuth instead of basic auth" should not become "change auth".',
      "- Do NOT put the option selection into the context field — context is only for ADDITIONAL information.",
      '- Do NOT return context for filler words — "um yeah sure" → option: affirmative, context: null.',
    ].join("\n"),
    prompt: [question ? `Question: ${question}` : "", `Options: ${options.join(", ")}`, `User said: "${transcript}"`]
      .filter(Boolean)
      .join("\n"),
  })
  const option = result.object.option
  return {
    option: option && options.includes(option) ? option : null,
    context: result.object.context || null,
    confidence: parseFloat(result.object.confidence),
  }
}

const multiSchema = z.object({
  options: z.array(z.string()).describe("Options the user affirmed or mentioned positively, empty if unclear"),
  context: z
    .string()
    .nullable()
    .describe(
      "Any additional context, instructions, or reasoning the user expressed beyond their option choices, or null if none",
    ),
  confidence: z
    .enum(["0", "0.25", "0.5", "0.75", "1"])
    .describe("How confident you are overall: 0 = completely unsure, 1 = very confident"),
})

export async function classifyMulti(model: LanguageModelV3, transcript: string, options: string[], question?: string) {
  const result = await generateObject({
    model,
    schema: multiSchema,
    system: [
      "You are classifying a voice transcript to identify which options the user said positively.",
      "The user spoke their answer aloud and it was transcribed. Include only options they affirmed or mentioned positively.",
      "Exclude any option the user negated or rejected (e.g. 'not X', 'except X', 'skip X').",
      "Return an empty array if the transcript is unclear or unrelated to any option.",
      "Each element in the options array must be exactly one of the provided option strings.",
      "Return '1' for confidence only when the matches are unambiguous.",
      "",
      "CONTEXT EXTRACTION:",
      "If the user expressed additional context, instructions, feedback, or reasoning beyond just picking options, extract that into the context field.",
      "Preserve the user's meaning faithfully — do not omit details, do not add interpretation.",
      "Return null for context if the user only indicated their choices with no extra information.",
      "",
      "GOOD examples:",
      '- User: "Yes to logging and metrics, but make sure metrics use Prometheus format" → options: [logging, metrics], context: "make sure metrics use Prometheus format"',
      '- User: "All of them except caching" → options: [all except caching], context: null',
      '- User: "Logging and metrics" → options: [logging, metrics], context: null',
      "",
      "BAD examples (do NOT do these):",
      "- Do NOT return context: null when the user clearly gave extra instructions beyond their choices.",
      "- Do NOT paraphrase loosely — preserve the user's specific wording and details.",
      "- Do NOT put the option selections into the context field — context is only for ADDITIONAL information.",
      '- Do NOT return context for filler words — "yeah those two sound good" → context: null.',
    ].join("\n"),
    prompt: [question ? `Question: ${question}` : "", `Options: ${options.join(", ")}`, `User said: "${transcript}"`]
      .filter(Boolean)
      .join("\n"),
  })
  return {
    options: result.object.options.filter((o) => options.includes(o)),
    context: result.object.context || null,
    confidence: parseFloat(result.object.confidence),
  }
}
