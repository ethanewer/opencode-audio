import { experimental_transcribe as transcribeAudio } from "ai"
import { createOpenAI } from "@ai-sdk/openai"

const openai = createOpenAI()

export async function transcribe(audio: Uint8Array, model?: string, options?: { abortSignal?: AbortSignal }) {
  const result = await transcribeAudio({
    model: openai.transcription(model ?? "gpt-4o-mini-transcribe"),
    audio,
    abortSignal: options?.abortSignal,
  })
  return result.text
}

export async function transcribeFile(path: string, model?: string) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 120_000)
  try {
    const audio = new Uint8Array(await Bun.file(path).arrayBuffer())
    return await transcribe(audio, model, { abortSignal: controller.signal })
  } finally {
    clearTimeout(timeout)
  }
}
