import { experimental_generateSpeech as generateSpeech } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import { which } from "bun"
import { tmpdir } from "os"
import { join } from "path"
import { unlinkSync } from "fs"

const openai = createOpenAI()

export async function speak(
  text: string,
  options?: { model?: string; voice?: string; abortSignal?: AbortSignal },
): Promise<Uint8Array> {
  const result = await generateSpeech({
    model: openai.speech(options?.model ?? "gpt-4o-mini-tts"),
    text,
    voice: options?.voice ?? "coral",
    outputFormat: "wav",
    abortSignal: options?.abortSignal,
  })
  return result.audio.uint8Array
}

type PlaybackMethod =
  | { type: "stdin"; cmd: string[] }
  | { type: "file"; cmd: (path: string) => string[] }

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
    remaining /= 0.5
  }
  filters.push(`atempo=${remaining}`)
  return filters.join(",")
}

function playbackMethod(speed: number): PlaybackMethod {
  if (which("ffplay")) {
    const cmd = ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"]
    if (speed !== 1) cmd.push("-af", atempoFilter(speed))
    cmd.push("-f", "wav", "-i", "pipe:0")
    return { type: "stdin", cmd }
  }
  if (which("afplay")) {
    return { type: "file", cmd: (path) => ["afplay", ...(speed !== 1 ? ["-r", String(speed)] : []), path] }
  }
  if (which("aplay")) return { type: "stdin", cmd: ["aplay", "-q", "-"] }
  throw new Error("ffplay, afplay, or aplay is required for voice output. Install with: brew install ffmpeg")
}

export function play(audio: Uint8Array, options?: { speed?: number }) {
  const speed = options?.speed ?? 1
  const method = playbackMethod(speed)

  if (method.type === "stdin") {
    const proc = Bun.spawn(method.cmd, {
      stdin: "pipe",
      stdout: "ignore",
      stderr: "ignore",
    })
    proc.stdin.write(audio)
    proc.stdin.end()

    return {
      stop() { proc.kill("SIGTERM") },
      done: proc.exited,
    }
  }

  // File-based playback (afplay)
  const tmpPath = join(tmpdir(), `opencode-tts-${Date.now()}.wav`)
  Bun.write(tmpPath, audio)

  const proc = Bun.spawn(method.cmd(tmpPath), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })

  const done = proc.exited.then(() => {
    try { unlinkSync(tmpPath) } catch {}
  })

  return {
    stop() {
      proc.kill("SIGTERM")
      try { unlinkSync(tmpPath) } catch {}
    },
    done,
  }
}
