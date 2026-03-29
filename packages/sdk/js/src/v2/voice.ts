import type { OpencodeClient } from "./gen/sdk.gen.js"
import type { Event, OutputFormat, PermissionRuleset } from "./gen/types.gen.js"

// ---------------------------------------------------------------------------
// AsyncAudioQueue — async iterable queue for raw audio data
// ---------------------------------------------------------------------------

export class AsyncAudioQueue implements AsyncIterable<Uint8Array> {
  private queue: Uint8Array[] = []
  private resolvers: Array<(value: IteratorResult<Uint8Array>) => void> = []
  private done = false

  /** Whether the queue has been closed. */
  get closed() {
    return this.done
  }

  /** Number of items currently buffered (pushed but not yet consumed). */
  get length() {
    return this.queue.length
  }

  push(data: Uint8Array) {
    if (this.done) return
    const resolve = this.resolvers.shift()
    if (resolve) resolve({ value: data, done: false })
    else this.queue.push(data)
  }

  close() {
    if (this.done) return
    this.done = true
    for (const resolve of this.resolvers) {
      resolve({ value: undefined as any, done: true })
    }
    this.resolvers.length = 0
  }

  async next(): Promise<IteratorResult<Uint8Array>> {
    if (this.queue.length > 0) return { value: this.queue.shift()!, done: false }
    if (this.done) return { value: undefined as any, done: true }
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const result = await this.next()
      if (result.done) return
      yield result.value
    }
  }
}

// ---------------------------------------------------------------------------
// Inlined audio utilities — thin OpenAI API wrappers
// ---------------------------------------------------------------------------

function env(key: string, fallback?: string): string {
  const val = typeof process !== "undefined" ? process.env[key] : undefined
  if (val) return val
  if (fallback) return fallback
  throw new Error(`${key} is required`)
}

// ---------------------------------------------------------------------------
// PCM-to-WAV wrapper for raw audio input
// ---------------------------------------------------------------------------

/** Audio format descriptor for raw PCM data. */
export interface PcmFormat {
  sampleRate: number
  channels: number
  bitDepth: number
}

/** Wrap raw PCM data in a WAV header. */
export function pcmToWav(pcm: Uint8Array, opts: PcmFormat): Uint8Array {
  const byteRate = opts.sampleRate * opts.channels * (opts.bitDepth / 8)
  const blockAlign = opts.channels * (opts.bitDepth / 8)
  const header = new ArrayBuffer(44)
  const v = new DataView(header)

  // RIFF header
  writeStr(v, 0, "RIFF")
  v.setUint32(4, 36 + pcm.length, true)
  writeStr(v, 8, "WAVE")
  // fmt chunk
  writeStr(v, 12, "fmt ")
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM format
  v.setUint16(22, opts.channels, true)
  v.setUint32(24, opts.sampleRate, true)
  v.setUint32(28, byteRate, true)
  v.setUint16(32, blockAlign, true)
  v.setUint16(34, opts.bitDepth, true)
  // data chunk
  writeStr(v, 36, "data")
  v.setUint32(40, pcm.length, true)

  const wav = new Uint8Array(44 + pcm.length)
  wav.set(new Uint8Array(header), 0)
  wav.set(pcm, 44)
  return wav
}

function writeStr(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}

// ---------------------------------------------------------------------------
// STT — speech-to-text
// ---------------------------------------------------------------------------

export interface SttOptions {
  /** Transcription model. Defaults to "gpt-4o-mini-transcribe". */
  model?: string
  apiKey?: string
  baseUrl?: string
  /** Abort signal to cancel the transcription request. */
  signal?: AbortSignal
  /**
   * When provided, the input Uint8Array is treated as raw PCM and
   * wrapped in a WAV header before sending. Omit to send the buffer
   * as-is (caller is responsible for providing a valid audio file).
   */
  format?: PcmFormat
}

export async function stt(audio: Uint8Array, options?: SttOptions): Promise<string> {
  const url = `${options?.baseUrl ?? env("OPENAI_BASE_URL", "https://api.openai.com/v1")}/audio/transcriptions`
  const key = options?.apiKey ?? env("OPENAI_API_KEY")

  const data = options?.format ? pcmToWav(audio, options.format) : audio
  const form = new FormData()
  form.append("file", new Blob([data as BlobPart], { type: "audio/wav" }), "audio.wav")
  form.append("model", options?.model ?? "gpt-4o-mini-transcribe")

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal: options?.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`OpenAI STT error ${res.status}: ${body}`)
  }
  const json = (await res.json()) as { text: string }
  return json.text
}

// ---------------------------------------------------------------------------
// TTS — text-to-speech
// ---------------------------------------------------------------------------

export interface TtsOptions {
  /** TTS model. Defaults to "gpt-4o-mini-tts". */
  model?: string
  /** Voice. Defaults to "coral". */
  voice?: string
  /** Playback speed multiplier (0.25–4.0). Defaults to 1.0. */
  speed?: number
  apiKey?: string
  baseUrl?: string
  /** Abort signal to cancel the TTS request. */
  signal?: AbortSignal
}

export async function tts(text: string, options?: TtsOptions): Promise<ReadableStream<Uint8Array>> {
  const url = `${options?.baseUrl ?? env("OPENAI_BASE_URL", "https://api.openai.com/v1")}/audio/speech`
  const key = options?.apiKey ?? env("OPENAI_API_KEY")
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options?.model ?? "gpt-4o-mini-tts",
      input: text,
      voice: options?.voice ?? "coral",
      response_format: "pcm",
      ...(options?.speed !== undefined ? { speed: options.speed } : {}),
    }),
    signal: options?.signal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`OpenAI TTS error ${res.status}: ${body}`)
  }
  if (!res.body) throw new Error("OpenAI TTS returned no body")
  return res.body as ReadableStream<Uint8Array>
}

// ---------------------------------------------------------------------------
// Sentence splitting & sanitization (mirrored from speech-queue.ts)
// ---------------------------------------------------------------------------

const DEFAULT_MIN_SENTENCE_LENGTH = 40

export function splitSentences(
  text: string,
  force: boolean,
  minLength?: number,
): { complete: string[]; remaining: string } {
  const min = minLength ?? DEFAULT_MIN_SENTENCE_LENGTH
  const complete: string[] = []
  let remaining = text
  let accumulated = ""

  while (true) {
    const match = remaining.match(/[.!?]\s+|\n\n/)
    if (!match || match.index === undefined) break
    const end = match.index + match[0].length
    accumulated += remaining.slice(0, end)
    remaining = remaining.slice(end)
    if (accumulated.trim().length >= min) {
      complete.push(accumulated.trim())
      accumulated = ""
    }
  }

  remaining = accumulated + remaining
  if (force && remaining.trim()) {
    complete.push(remaining.trim())
    remaining = ""
  }

  return { complete, remaining }
}

export function sanitize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "code block")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

// ---------------------------------------------------------------------------
// Stream TTS audio chunks to an output queue as they arrive
// ---------------------------------------------------------------------------

async function streamToQueue(
  stream: ReadableStream<Uint8Array>,
  queue: AsyncAudioQueue,
  gen: () => number,
  expected: number,
) {
  const reader = stream.getReader()
  try {
    while (true) {
      if (gen() !== expected) break
      const { done, value } = await reader.read()
      if (done) break
      if (gen() !== expected) break
      queue.push(value)
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// createVoiceSession — the main voice SDK entry point
// ---------------------------------------------------------------------------

export type PermissionMode = "safe" | "dangerous"

export interface VoiceSessionOptions {
  // ---- Session creation ----

  /** Existing session ID to reuse. If omitted, a new session is created. */
  sessionID?: string
  /** Session title (used when creating a new session). */
  title?: string
  /** Parent session ID for forking (used when creating a new session). */
  parentID?: string
  /**
   * Permission mode or a custom ruleset.
   * - `"safe"` (default) — auto-rejects any permission prompts at runtime.
   * - `"dangerous"` — creates the session with a wildcard allow-all ruleset.
   * - `PermissionRuleset` — a custom array of permission rules applied to the session.
   *   When a custom ruleset is provided, runtime permission prompts are still auto-rejected
   *   (same as "safe") unless the ruleset itself allows them.
   */
  permission?: PermissionMode | PermissionRuleset

  // ---- Prompt / agent ----

  /** Agent name. Defaults to "voice-build". */
  agent?: string
  /** LLM model override as { providerID, modelID }. */
  model?: { providerID: string; modelID: string }
  /** Custom system prompt appended to the agent's default system prompt. */
  system?: string
  /**
   * Tool enable/disable map. Keys are tool names, values are booleans.
   * `true` enables, `false` disables. Unspecified tools use agent defaults.
   */
  tools?: { [key: string]: boolean }
  /** Output format override (text or JSON schema). */
  format?: OutputFormat
  /** Prompt variant identifier. */
  variant?: string
  /**
   * When true the assistant will not reply — useful for injecting context
   * messages without triggering a response.
   */
  noReply?: boolean

  // ---- Audio ----

  /** TTS options (model, voice, speed, apiKey, baseUrl). */
  tts?: Omit<TtsOptions, "signal">
  /** STT options (model, apiKey, baseUrl, format for raw PCM input). */
  stt?: Omit<SttOptions, "signal">

  /**
   * Minimum character count before a sentence is emitted for TTS.
   * Lower values reduce latency for short responses; higher values
   * produce more natural-sounding speech. Defaults to 40.
   */
  minSentenceLength?: number

  /**
   * When true, tool execution status is spoken on the output queue
   * (e.g. "Running bash" / "Completed edit"). Mirrors the TUI's
   * StatusSpeaker behavior. Defaults to false.
   */
  toolStatus?: boolean
}

export interface VoiceSession {
  /** Push recorded audio here. Each Uint8Array is one utterance to transcribe. */
  input: AsyncAudioQueue
  /** Read synthesized speech audio from here. Each Uint8Array is one chunk of PCM audio (streamed incrementally). */
  output: AsyncAudioQueue
  /** The underlying session ID. */
  sessionID: string
  /** Abort current processing without closing the session. */
  abort(): void
  /** Shut down the voice session, closing both queues and the event stream. */
  close(): void
  /**
   * Resolves when all background loops have exited after `close()` is called.
   * Useful for graceful shutdown or test teardown.
   */
  done: Promise<void>
}

export async function createVoiceSession(client: OpencodeClient, options?: VoiceSessionOptions): Promise<VoiceSession> {
  const perm = options?.permission ?? "safe"
  const agent = options?.agent ?? "voice-build"
  const minLen = options?.minSentenceLength ?? DEFAULT_MIN_SENTENCE_LENGTH
  const speakStatus = options?.toolStatus ?? false

  // Resolve permission mode:
  //  "dangerous" → wildcard allow-all ruleset
  //  "safe"      → no extra rules (auto-reject at runtime)
  //  array       → custom ruleset passed directly
  const isDangerous = perm === "dangerous"
  const permission: PermissionRuleset | undefined = isDangerous
    ? [{ permission: "*", pattern: "*", action: "allow" as const }]
    : Array.isArray(perm)
      ? perm
      : undefined

  // Create or reuse session
  let sessionID: string
  if (options?.sessionID) {
    sessionID = options.sessionID
  } else {
    const res = await client.session.create({
      permission,
      title: options?.title,
      parentID: options?.parentID,
    })
    if (res.error) throw new Error("Failed to create session")
    sessionID = res.data!.id
  }

  // Subscribe to SSE event stream
  const ctrl = new AbortController()
  const events = await client.event.subscribe({}, { signal: ctrl.signal })

  const input = new AsyncAudioQueue()
  const output = new AsyncAudioQueue()
  let aborted = false

  // Track current generation to support abort
  let generation = 0
  const gen = () => generation

  // ---- Output loop: SSE events -> sentence splitting -> TTS -> output queue ----
  let buffer = ""
  let active = "" // messageID of the current assistant response

  async function speakText(text: string, expected: number) {
    try {
      const stream = await tts(text, {
        model: options?.tts?.model,
        voice: options?.tts?.voice,
        speed: options?.tts?.speed,
        apiKey: options?.tts?.apiKey,
        baseUrl: options?.tts?.baseUrl,
        signal: ctrl.signal,
      })
      if (generation !== expected) return
      await streamToQueue(stream, output, gen, expected)
    } catch {
      // TTS error — skip, don't crash the loop
    }
  }

  async function handleDelta(delta: string, expected: number) {
    buffer += delta
    const result = splitSentences(buffer, false, minLen)
    buffer = result.remaining
    for (const sentence of result.complete) {
      if (generation !== expected) return
      const cleaned = sanitize(sentence)
      if (!cleaned) continue
      await speakText(cleaned, expected)
    }
  }

  async function flushBuffer(expected: number) {
    if (!buffer.trim()) return
    const result = splitSentences(buffer, true, minLen)
    buffer = result.remaining
    for (const sentence of result.complete) {
      if (generation !== expected) return
      const cleaned = sanitize(sentence)
      if (!cleaned) continue
      await speakText(cleaned, expected)
    }
  }

  // Start the SSE consumer loop in the background
  const sseLoop = (async () => {
    try {
      for await (const event of events.stream) {
        if (aborted) break
        const evt = event as Event
        if (evt.type === "message.part.delta") {
          if (evt.properties.sessionID !== sessionID) continue
          if (evt.properties.field !== "text") continue
          if (!active) active = evt.properties.messageID
          if (evt.properties.messageID !== active) continue
          await handleDelta(evt.properties.delta, generation)
        } else if (evt.type === "session.status") {
          if (evt.properties.sessionID !== sessionID) continue
          if (evt.properties.status.type === "idle") {
            await flushBuffer(generation)
            active = ""
          }
        } else if (evt.type === "permission.asked" && !isDangerous) {
          if (evt.properties.sessionID !== sessionID) continue
          client.permission.reply({
            requestID: evt.properties.id,
            reply: "reject",
          })
        } else if (evt.type === "message.part.updated" && speakStatus) {
          if (evt.properties.sessionID !== sessionID) continue
          const part = evt.properties.part
          if (part.type !== "tool") continue
          const state = part.state
          if (state.status === "running") {
            const label = state.title ?? part.tool
            await speakText(`Running ${label}.`, generation)
          } else if (state.status === "completed") {
            const label = state.title ?? part.tool
            await speakText(`Completed ${label}.`, generation)
          } else if (state.status === "error") {
            await speakText(`Error in ${part.tool}.`, generation)
          }
        }
      }
    } catch {
      // Stream ended or aborted — expected on close()
    }
  })()

  // ---- Input loop: input queue -> STT -> prompt ----
  const inputLoop = (async () => {
    for await (const audio of input) {
      if (aborted) break
      const expected = generation
      try {
        const text = await stt(audio, {
          model: options?.stt?.model,
          apiKey: options?.stt?.apiKey,
          baseUrl: options?.stt?.baseUrl,
          format: options?.stt?.format,
          signal: ctrl.signal,
        })
        if (!text.trim() || generation !== expected) continue
        // Reset output state for new prompt
        buffer = ""
        active = ""
        await client.session.prompt({
          sessionID,
          agent,
          parts: [{ type: "text", text }],
          ...(options?.model ? { model: options.model } : {}),
          ...(options?.system ? { system: options.system } : {}),
          ...(options?.tools ? { tools: options.tools } : {}),
          ...(options?.format ? { format: options.format } : {}),
          ...(options?.variant ? { variant: options.variant } : {}),
          ...(options?.noReply !== undefined ? { noReply: options.noReply } : {}),
        })
      } catch {
        // STT or prompt error — skip this input
      }
    }
  })()

  const done = Promise.all([sseLoop, inputLoop]).then(() => {})

  function abort() {
    generation++
    buffer = ""
    active = ""
    client.session.abort({ sessionID }).catch(() => {})
  }

  function close() {
    aborted = true
    generation++
    ctrl.abort()
    input.close()
    output.close()
  }

  return { input, output, sessionID, abort, close, done }
}
