import type { OpencodeClient } from "./gen/sdk.gen.js"
import type { Event, OutputFormat, PermissionRuleset } from "./gen/types.gen.js"

// ---------------------------------------------------------------------------
// AsyncQueue — generic async iterable queue
// ---------------------------------------------------------------------------

export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: Array<(value: IteratorResult<T>) => void> = []
  private done = false

  /** Whether the queue has been closed. */
  get closed() {
    return this.done
  }

  /** Number of items currently buffered (pushed but not yet consumed). */
  get length() {
    return this.queue.length
  }

  push(data: T) {
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

  async next(): Promise<IteratorResult<T>> {
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
// AsyncAudioQueue — async iterable queue for raw audio data
// ---------------------------------------------------------------------------

export class AsyncAudioQueue extends AsyncQueue<Uint8Array> {}

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
  return (
    text
      .replace(/```[\s\S]*?```/g, "code block")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Remove numbered list prefixes
      .replace(/^\s*\d+[.)]\s+/gm, "")
      // Remove bullet list prefixes
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim()
  )
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

/**
 * A voice system groups a model with optional STT and TTS configuration.
 * Mirrors the TUI config `system` structure with a single agent instead of
 * an agents array.
 */
export interface VoiceSystem {
  /** Main LLM model in provider/model format (e.g. "anthropic/claude-opus-4-6"). */
  model: string
  /** Model variant / reasoning effort (e.g. "medium", "high", "max"). */
  variant?: string
  /** STT model for voice input transcription (e.g. "gpt-4o-mini-transcribe"). */
  transcription?: string
  /** TTS configuration for voice output. */
  tts?: {
    model?: string
    voice?: string
    speed?: number
  }
  /** Agent name. Defaults to "voice-build". */
  agent?: string
  /** OpenAI API key for STT/TTS requests. Falls back to OPENAI_API_KEY env var. */
  apiKey?: string
  /** OpenAI base URL for STT/TTS requests. Falls back to OPENAI_BASE_URL env var. */
  baseUrl?: string
  /**
   * When true and toolStatus is enabled, buffer tool status messages and
   * produce one TTS call per turn instead of speaking each status
   * individually. Default: false.
   */
  batchTurns?: boolean
}

const TTS_DEFAULT = { model: "gpt-4o-mini-tts", voice: "echo", speed: 1.25 }
const STT_DEFAULT = "gpt-4o-mini-transcribe"

/**
 * Built-in voice systems. Each is a ready-to-use system with TTS and
 * transcription configured. Pass the key as a string to
 * `createVoiceSession({ system: "claude-opus-medium-voice" })`.
 */
export const voiceSystems = {
  "claude-opus-medium-voice": {
    model: "anthropic/claude-opus-4-6",
    variant: "medium",
    transcription: STT_DEFAULT,
    tts: TTS_DEFAULT,
  },
  "claude-opus-high-voice": {
    model: "anthropic/claude-opus-4-6",
    variant: "high",
    transcription: STT_DEFAULT,
    tts: TTS_DEFAULT,
  },
  "claude-opus-max-voice": {
    model: "anthropic/claude-opus-4-6",
    variant: "max",
    transcription: STT_DEFAULT,
    tts: TTS_DEFAULT,
  },
  "gpt-medium-voice": {
    model: "openai/gpt-5.4",
    variant: "medium",
    transcription: STT_DEFAULT,
    tts: TTS_DEFAULT,
  },
  "gpt-high-voice": {
    model: "openai/gpt-5.4",
    variant: "high",
    transcription: STT_DEFAULT,
    tts: TTS_DEFAULT,
  },
  "gpt-xhigh-voice": {
    model: "openai/gpt-5.4",
    variant: "xhigh",
    transcription: STT_DEFAULT,
    tts: TTS_DEFAULT,
  },
  "gpt-audio-voice": {
    model: "openai/gpt-audio",
  },
  "gemini-flash-voice": {
    model: "openrouter/google/gemini-3.1-flash-lite-preview",
    transcription: STT_DEFAULT,
    tts: TTS_DEFAULT,
  },
  "gemini-pro-voice": {
    model: "openrouter/google/gemini-3.1-pro-preview-customtools",
    transcription: STT_DEFAULT,
    tts: TTS_DEFAULT,
  },
  "minimax-m2-voice": {
    model: "openrouter/minimax/minimax-m2.7",
    transcription: STT_DEFAULT,
    tts: TTS_DEFAULT,
  },
} as const satisfies Record<string, VoiceSystem>

/** Name of a built-in voice system. */
export type VoiceSystemName = keyof typeof voiceSystems

export interface VoiceSessionOptions {
  /**
   * The voice system to use. Pass a built-in system name (e.g.
   * `"claude-opus-medium-voice"`) or a custom `VoiceSystem` object.
   */
  system: VoiceSystemName | VoiceSystem

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
   * - `"dangerous"` — allows the model to read and write to any directory
   *   without prompting. Scoped to file-system access only — does not change
   *   tool availability or enable otherwise-disabled tools.
   * - `PermissionRuleset` — a custom array of permission rules applied to the session.
   *   When a custom ruleset is provided, runtime permission prompts are still auto-rejected
   *   (same as "safe") unless the ruleset itself allows them.
   */
  permission?: PermissionMode | PermissionRuleset

  // ---- Prompt overrides ----

  /** Custom system prompt appended to the agent's default system prompt. */
  prompt?: string
  /**
   * Tool enable/disable map. Keys are tool names, values are booleans.
   * `true` enables, `false` disables. Unspecified tools use agent defaults.
   */
  tools?: { [key: string]: boolean }
  /** Output format override (text or JSON schema). */
  format?: OutputFormat
  /**
   * When true the assistant will not reply — useful for injecting context
   * messages without triggering a response.
   */
  noReply?: boolean

  // ---- Audio behavior ----

  /**
   * When true, tool execution status is spoken on the output queue
   * (e.g. "Running bash" / "Completed edit"). Mirrors the TUI's
   * StatusSpeaker behavior. Defaults to false.
   */
  toolStatus?: boolean

  /**
   * When true, audio input is sent directly to the model as a file part
   * instead of being transcribed via STT first. Use this for models that
   * accept audio input natively (e.g. Gemini 3.1 Flash Lite, GPT Audio).
   *
   * When undefined, auto-detected from the model's capabilities: defaults
   * to true if the model supports audio input, false otherwise.
   */
  nativeAudioInput?: boolean

  /**
   * When true, audio output from the model is pushed directly to the
   * output queue instead of running text through TTS. Use this for models
   * that produce native audio output (e.g. GPT Audio). The model's audio
   * is emitted as PCM data on the output queue.
   *
   * When undefined, auto-detected from the model's capabilities: defaults
   * to true if the model supports audio output, false otherwise.
   */
  nativeAudioOutput?: boolean

  /**
   * When true and toolStatus is enabled, buffer tool status messages and
   * produce one TTS call per turn instead of speaking each status
   * individually. Default: false.
   */
  batchTurns?: boolean
}

export interface VoiceSession {
  /** Push recorded audio here. Each Uint8Array is one utterance to transcribe. */
  input: AsyncAudioQueue
  /** Read synthesized speech audio from here. Each Uint8Array is one chunk of PCM audio (streamed incrementally). */
  output: AsyncAudioQueue
  /**
   * Text transcript of the audio output. Emits sanitized text segments as
   * they become available — one per sentence for TTS-based systems, or the
   * full model transcript for native-audio systems like GPT-Audio. Always
   * present; simply don't iterate if not needed.
   */
  transcript: AsyncQueue<string>
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

function parseModel(id: string) {
  const [providerID, ...rest] = id.split("/")
  return { providerID, modelID: rest.join("/") }
}

export async function createVoiceSession(client: OpencodeClient, options: VoiceSessionOptions): Promise<VoiceSession> {
  const sys: VoiceSystem = typeof options.system === "string" ? voiceSystems[options.system] : options.system
  const perm = options.permission ?? "safe"
  const speakStatus = options.toolStatus ?? false
  const batch = options.batchTurns ?? sys.batchTurns ?? false

  // Resolve system fields
  const model = parseModel(sys.model)
  const agent = sys.agent ?? "voice-build"
  const ttsOpts = sys.tts
    ? { ...sys.tts, apiKey: sys.apiKey, baseUrl: sys.baseUrl }
    : sys.apiKey || sys.baseUrl
      ? { apiKey: sys.apiKey, baseUrl: sys.baseUrl }
      : undefined
  const sttOpts: Omit<SttOptions, "signal"> | undefined =
    sys.transcription || sys.apiKey || sys.baseUrl
      ? { model: sys.transcription, apiKey: sys.apiKey, baseUrl: sys.baseUrl }
      : undefined
  const variant = sys.variant

  // Auto-detect native audio capabilities from the model if not explicitly set
  let sendAudio = options.nativeAudioInput ?? false
  let receiveAudio = options.nativeAudioOutput ?? false
  if (options.nativeAudioInput === undefined || options.nativeAudioOutput === undefined) {
    try {
      const res = await client.provider.list()
      if (res.data) {
        const provider = res.data.all.find((p) => p.id === model.providerID)
        const info = provider?.models[model.modelID] as Record<string, any> | undefined
        const modalities = info?.modalities ?? info?.capabilities
        if (modalities) {
          const hasInput =
            modalities.input?.audio === true || (Array.isArray(modalities.input) && modalities.input.includes("audio"))
          const hasOutput =
            modalities.output?.audio === true ||
            (Array.isArray(modalities.output) && modalities.output.includes("audio"))
          if (options.nativeAudioInput === undefined) sendAudio = hasInput
          if (options.nativeAudioOutput === undefined) receiveAudio = hasOutput
        }
      }
    } catch {
      // Provider lookup failed — fall back to defaults (STT/TTS)
    }
  }

  // Resolve permission mode:
  //  "dangerous" → allow file-system read/write without prompting
  //  "safe"      → no extra rules (auto-reject at runtime)
  //  array       → custom ruleset passed directly
  const isDangerous = perm === "dangerous"
  const permission: PermissionRuleset | undefined = isDangerous
    ? [
        { permission: "read", pattern: "*", action: "allow" as const },
        { permission: "edit", pattern: "*", action: "allow" as const },
        { permission: "external_directory", pattern: "*", action: "allow" as const },
      ]
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
  const transcript = new AsyncQueue<string>()
  let aborted = false

  // Track current generation to support abort
  let generation = 0
  const gen = () => generation

  // ---- Output loop: SSE events -> sentence splitting -> TTS -> output queue ----
  let buffer = ""
  let sbuf = "" // batched tool-status buffer (TTS'd on idle)
  let tbuf = "" // transcript buffer for native-audio models
  let active = "" // messageID of the current assistant response

  async function speakText(text: string, expected: number) {
    try {
      const stream = await tts(text, {
        model: ttsOpts?.model,
        voice: ttsOpts?.voice,
        speed: ttsOpts?.speed,
        apiKey: ttsOpts?.apiKey,
        baseUrl: ttsOpts?.baseUrl,
        signal: ctrl.signal,
      })
      if (generation !== expected) return
      await streamToQueue(stream, output, gen, expected)
    } catch {
      // TTS error — skip, don't crash the loop
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
          if (receiveAudio) {
            tbuf += evt.properties.delta
            continue
          }
          // Accumulate for transcript only — TTS is driven by speak tool
          buffer += evt.properties.delta
        } else if (evt.type === "session.status") {
          if (evt.properties.sessionID !== sessionID) continue
          if (evt.properties.status.type === "idle") {
            if (receiveAudio) {
              if (tbuf.trim()) transcript.push(tbuf.trim())
              tbuf = ""
            } else {
              if (buffer.trim()) {
                const text = sanitize(buffer)
                buffer = ""
                if (text) transcript.push(text)
              }
              if (sbuf.trim()) {
                const text = sanitize(sbuf)
                sbuf = ""
                if (text) {
                  transcript.push(text)
                  await speakText(text, generation)
                }
              }
            }
            active = ""
            // Push a zero-length sentinel so consumers waiting on the output
            // queue can detect that the turn's audio is complete. With speak-tool
            // TTS, all audio arrives *before* idle fires; without this sentinel,
            // a `for await (const pcm of output)` loop would block indefinitely
            // waiting for more data.
            output.push(new Uint8Array(0))
          }
        } else if (evt.type === "permission.asked" && !isDangerous) {
          if (evt.properties.sessionID !== sessionID) continue
          client.permission.reply({
            requestID: evt.properties.id,
            reply: "reject",
          })
        } else if (evt.type === "message.part.updated") {
          if (evt.properties.sessionID !== sessionID) continue
          const part = evt.properties.part

          // Native audio (gpt-audio) — push PCM directly to output queue
          if (receiveAudio && part.type === "file" && part.mime.startsWith("audio/")) {
            const b64 = part.url.split(",")[1]
            if (b64) {
              const pcm =
                typeof Buffer !== "undefined"
                  ? new Uint8Array(Buffer.from(b64, "base64"))
                  : (() => {
                      const s = atob(b64)
                      const a = new Uint8Array(s.length)
                      for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i)
                      return a
                    })()
              output.push(pcm)
            }
          }

          // Speak or voice task_complete — TTS the text
          if (
            part.type === "tool" &&
            (part.tool === "speak" || part.tool === "task_complete") &&
            part.state.status === "completed" &&
            part.state.input?.text
          ) {
            const text = String(part.state.input.text)
            transcript.push(text)
            await speakText(text, generation)
          }

          // Tool status speech (opt-in, excludes speak and task_complete)
          if (speakStatus && part.type === "tool" && part.tool !== "speak" && part.tool !== "task_complete") {
            const state = part.state
            let text: string | undefined
            if (state.status === "running") {
              const label = state.title ?? part.tool
              text = `Running ${label}.`
            } else if (state.status === "completed") {
              const label = state.title ?? part.tool
              text = `Completed ${label}.`
            } else if (state.status === "error") {
              text = `Error in ${part.tool}.`
            }
            if (text) {
              if (batch) {
                sbuf += (sbuf ? " " : "") + text
              } else {
                transcript.push(text)
                await speakText(text, generation)
              }
            }
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
        const parts: Array<
          { type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }
        > = []
        if (sendAudio) {
          const b64 =
            typeof Buffer !== "undefined"
              ? Buffer.from(audio).toString("base64")
              : (() => {
                  let s = ""
                  for (let i = 0; i < audio.length; i++) s += String.fromCharCode(audio[i])
                  return btoa(s)
                })()
          parts.push({
            type: "file",
            mime: "audio/wav",
            url: `data:audio/wav;base64,${b64}`,
            filename: "recording.wav",
          })
          parts.push({ type: "text", text: "[voice audio input]" })
        } else {
          const text = await stt(audio, {
            model: sttOpts?.model,
            apiKey: sttOpts?.apiKey,
            baseUrl: sttOpts?.baseUrl,
            format: sttOpts?.format,
            signal: ctrl.signal,
          })
          if (!text.trim() || generation !== expected) continue
          parts.push({ type: "text", text })
        }
        // Reset output state for new prompt
        buffer = ""
        sbuf = ""
        tbuf = ""
        active = ""
        await client.session.prompt({
          sessionID,
          agent,
          parts,
          model,
          ...(options.prompt ? { system: options.prompt } : {}),
          ...(options.tools ? { tools: options.tools } : {}),
          ...(options.format ? { format: options.format } : {}),
          ...(variant ? { variant } : {}),
          ...(options.noReply !== undefined ? { noReply: options.noReply } : {}),
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
    sbuf = ""
    tbuf = ""
    active = ""
    client.session.abort({ sessionID }).catch(() => {})
  }

  function close() {
    aborted = true
    generation++
    ctrl.abort()
    input.close()
    output.close()
    transcript.close()
  }

  return { input, output, transcript, sessionID, abort, close, done }
}
