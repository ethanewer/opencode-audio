import { which } from "bun"
import { tmpdir } from "os"
import { join } from "path"
import { unlinkSync } from "fs"

function baseUrl(): string {
  return process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"
}

function ttsUrl(): string {
  return `${baseUrl()}/audio/speech`
}

// PCM format: raw 24kHz 16-bit signed little-endian mono
const SAMPLE_RATE = 24000
const CHANNELS = 1
const BITS = 16

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY
  if (!key) throw new Error("OPENAI_API_KEY is required for TTS")
  return key
}

// Pre-warm the TLS connection to OpenAI on first import.
// This front-loads DNS + TCP + TLS handshake (~100-300ms) so the
// first real TTS request doesn't pay that cost.
let warmed = false
export function warmup() {
  if (warmed) return
  warmed = true
  try {
    // Fire-and-forget HEAD request to establish the connection pool
    fetch(ttsUrl(), {
      method: "HEAD",
      headers: { Authorization: `Bearer ${apiKey()}` },
    }).catch(() => {})
  } catch {}
}

/** Generate speech audio as a full buffer (for RPC / non-streaming callers). */
export async function speak(
  text: string,
  options?: { model?: string; voice?: string; abortSignal?: AbortSignal },
): Promise<Uint8Array> {
  const res = await fetch(ttsUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options?.model ?? "gpt-4o-mini-tts",
      input: text,
      voice: options?.voice ?? "coral",
      response_format: "pcm",
    }),
    signal: options?.abortSignal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`OpenAI TTS error ${res.status}: ${body}`)
  }
  return new Uint8Array(await res.arrayBuffer())
}

/** Generate speech and return a ReadableStream of PCM chunks for streaming playback. */
export async function speakStream(
  text: string,
  options?: { model?: string; voice?: string; abortSignal?: AbortSignal },
): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(ttsUrl(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options?.model ?? "gpt-4o-mini-tts",
      input: text,
      voice: options?.voice ?? "coral",
      response_format: "pcm",
    }),
    signal: options?.abortSignal,
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`OpenAI TTS error ${res.status}: ${body}`)
  }
  if (!res.body) throw new Error("OpenAI TTS returned no body")
  return res.body as ReadableStream<Uint8Array>
}

type PlaybackMethod = { type: "stdin"; cmd: string[] } | { type: "file"; cmd: (path: string) => string[] }

// ffplay's atempo filter only supports 0.5–2.0 per instance.
// For speeds outside that range, chain multiple atempo filters.
function atempoFilter(speed: number): string {
  const filters: string[] = []
  let remaining = speed
  while (remaining > 2.0) {
    filters.push("atempo=2.0")
    remaining /= 2.0
  }
  while (remaining < 0.5) {
    filters.push("atempo=0.5")
    remaining *= 2
  }
  filters.push(`atempo=${remaining}`)
  return filters.join(",")
}

function playbackMethod(speed: number, pcm: boolean): PlaybackMethod {
  if (which("ffplay")) {
    const cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]
    if (pcm) cmd.push("-f", "s16le", "-ar", String(SAMPLE_RATE))
    if (speed !== 1) cmd.push("-af", atempoFilter(speed))
    if (!pcm) cmd.push("-f", "wav")
    cmd.push("-i", "pipe:0")
    return { type: "stdin", cmd }
  }
  if (which("afplay")) {
    return { type: "file", cmd: (path) => ["afplay", ...(speed !== 1 ? ["-r", String(speed)] : []), path] }
  }
  if (which("aplay")) {
    const cmd = ["aplay", "-q"]
    if (pcm) cmd.push("-f", "S16_LE", "-r", String(SAMPLE_RATE), "-c", String(CHANNELS))
    cmd.push("-")
    return { type: "stdin", cmd }
  }
  throw new Error("ffplay, afplay, or aplay is required for voice output. Install with: brew install ffmpeg")
}

/** Play a complete audio buffer. */
export function play(audio: Uint8Array, options?: { speed?: number }) {
  const speed = options?.speed ?? 1
  const method = playbackMethod(speed, true)

  if (method.type === "stdin") {
    const proc = Bun.spawn(method.cmd, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    })
    proc.stdin.write(audio)
    proc.stdin.end()

    return {
      stop() {
        proc.kill("SIGTERM")
      },
      done: proc.exited,
    }
  }

  // File-based playback (afplay) — write PCM with WAV header for compatibility
  const wav = pcmToWav(audio)
  const tmpPath = join(tmpdir(), `opencode-tts-${Date.now()}.wav`)
  Bun.write(tmpPath, wav)

  const proc = Bun.spawn(method.cmd(tmpPath), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })

  const done = proc.exited.then(() => {
    try {
      unlinkSync(tmpPath)
    } catch {}
  })

  return {
    stop() {
      proc.kill("SIGTERM")
      try {
        unlinkSync(tmpPath)
      } catch {}
    },
    done,
  }
}

/** Stream audio from a ReadableStream directly to the audio player.
 *  Playback begins as soon as the first chunk arrives. */
export function playStream(stream: ReadableStream<Uint8Array>, options?: { speed?: number }) {
  const speed = options?.speed ?? 1
  const method = playbackMethod(speed, true)

  if (method.type === "stdin") {
    const proc = Bun.spawn(method.cmd, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    })

    // Pipe chunks to stdin as they arrive
    const pipe = (async () => {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          proc.stdin.write(value)
        }
      } catch {
        // Stream was cancelled or errored
      } finally {
        try {
          proc.stdin.end()
        } catch {}
      }
    })()

    return {
      stop() {
        stream.cancel().catch(() => {})
        proc.kill("SIGTERM")
      },
      done: pipe
        .then(() => proc.exited)
        .then(
          () => {},
          () => {},
        ),
    }
  }

  // File-based (afplay): must buffer the full stream first, then play
  let proc: ReturnType<typeof Bun.spawn> | null = null
  const done = (async () => {
    const chunks: Uint8Array[] = []
    const reader = stream.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
    } catch {
      return // stream cancelled
    }
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const pcm = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      pcm.set(chunk, offset)
      offset += chunk.length
    }
    const wav = pcmToWav(pcm)
    const tmpPath = join(tmpdir(), `opencode-tts-${Date.now()}.wav`)
    await Bun.write(tmpPath, wav)
    proc = Bun.spawn(method.cmd(tmpPath), {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    })
    await proc.exited
    try {
      unlinkSync(tmpPath)
    } catch {}
  })()

  return {
    stop() {
      stream.cancel().catch(() => {})
      if (proc) proc.kill("SIGTERM")
    },
    done,
  }
}

/** Wrap raw PCM data in a WAV header for players that need it. */
function pcmToWav(pcm: Uint8Array): Uint8Array {
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS / 8)
  const blockAlign = CHANNELS * (BITS / 8)

  // RIFF header
  writeString(view, 0, "RIFF")
  view.setUint32(4, 36 + pcm.length, true)
  writeString(view, 8, "WAVE")
  // fmt chunk
  writeString(view, 12, "fmt ")
  view.setUint32(16, 16, true) // chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, CHANNELS, true)
  view.setUint32(24, SAMPLE_RATE, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, BITS, true)
  // data chunk
  writeString(view, 36, "data")
  view.setUint32(40, pcm.length, true)

  const wav = new Uint8Array(44 + pcm.length)
  wav.set(new Uint8Array(header), 0)
  wav.set(pcm, 44)
  return wav
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i))
  }
}
