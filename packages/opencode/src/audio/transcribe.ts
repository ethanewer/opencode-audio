export type TranscriptionUsage = {
  input_tokens: number
  output_tokens: number
  total_tokens: number
}

function baseUrl() {
  return process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
}

function apiKey() {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_API_KEY is required for transcription")
  return key
}

export async function transcribe(
  audio: Uint8Array,
  model?: string,
  options?: { abortSignal?: AbortSignal; onUsage?: (usage: TranscriptionUsage) => void },
) {
  const form = new FormData()
  form.append("file", new File([audio as BlobPart], "audio.wav", { type: "audio/wav" }))
  form.append("model", model ?? "gpt-4o-mini-transcribe")
  form.append("response_format", "json")

  const res = await fetch(`${baseUrl()}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}` },
    body: form,
    signal: options?.abortSignal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Transcription error ${res.status}: ${body}`)
  }
  const json = await res.json()
  if (json.usage?.type === "tokens" && options?.onUsage) {
    options.onUsage({
      input_tokens: json.usage.input_tokens,
      output_tokens: json.usage.output_tokens,
      total_tokens: json.usage.total_tokens,
    })
  }
  return json.text as string
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
