import { createSignal, onCleanup } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useLocal } from "@tui/context/local"
import { SpeechQueue } from "@/audio/speech-queue"
import { warmup, play } from "@/audio/speak"
import * as Speaker from "@/audio/speaker"
import * as AudioCost from "@/audio/cost"
import { TTS_OUTPUT_TOKENS_PER_SEC, PCM_BYTES_PER_SEC } from "@/audio/cost"

// TTS output cost rate estimate (per 1M output tokens) — gpt-4o-mini-tts
const TTS_OUTPUT_RATE = 2.4

export function useSpeech(sessionID: () => string) {
  const sdk = useSDK()
  const sync = useSync()
  const local = useLocal()

  const sysInfo = () => local.system.info()
  const ttsConfig = () => {
    // System TTS takes priority over global voice config
    const sys = sysInfo()
    if (sys.tts) return { ...sys.tts, enabled: true }
    return sync.data.config.experimental?.voice?.tts
  }
  const enabled = () => {
    if (!sync.data.config.experimental?.voice?.enabled) return false
    const sys = sysInfo()
    // Enabled if system has TTS or native audio output
    return sys.hasTts || sys.hasAudioOutput
  }

  const [speaking, setSpeaking] = createSignal(false)

  let queue: SpeechQueue | null = null
  let queueIdle = true

  // Pre-warm the TLS connection so the first TTS request is faster
  if (enabled()) warmup()

  function trackTtsCost(bytes: number) {
    const duration = bytes / PCM_BYTES_PER_SEC
    const outputTokens = duration * TTS_OUTPUT_TOKENS_PER_SEC
    const cost = (outputTokens * TTS_OUTPUT_RATE) / 1_000_000
    AudioCost.add(sessionID(), "output", cost)
  }

  function getQueue() {
    if (!enabled()) return null
    if (!queue) {
      const config = ttsConfig()
      queue = new SpeechQueue({
        model: config?.model,
        voice: config?.voice,
        speed: config?.speed,
        onIdle: () => {
          queueIdle = true
          setSpeaking(false)
        },
        onBytes: trackTtsCost,
      })
    }
    return queue
  }

  // Detect speak tool calls and native audio output
  const offPart = sdk.event.on("message.part.updated", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    const part = evt.properties.part

    // Model produced native audio (e.g. gpt-audio) — play directly
    // Native audio costs are tracked via the processor (getUsage), not here.
    if (part.type === "file" && "mime" in part && typeof part.mime === "string" && part.mime.startsWith("audio/")) {
      queue?.cancel()
      const b64 = "url" in part && typeof part.url === "string" ? part.url.split(",")[1] : undefined
      if (b64) {
        const pcm = Buffer.from(b64, "base64")
        const p = play(new Uint8Array(pcm))
        queueIdle = false
        setSpeaking(true)
        p.done.then(() => {
          queueIdle = true
          setSpeaking(false)
        })
      }
      return
    }

    // Speak tool completed — feed text to TTS queue
    if (
      part.type === "tool" &&
      part.tool === "speak" &&
      "state" in part &&
      part.state.status === "completed" &&
      part.state.input?.text
    ) {
      const q = getQueue()
      if (!q) return
      queueIdle = false
      setSpeaking(true)
      q.push(String(part.state.input.text))
      q.flush()
    }
  })

  // Flush queue when session goes idle
  const offStatus = sdk.event.on("session.status", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    if (evt.properties.status.type !== "idle") return
    queue?.flush()
  })

  // Announce permission requests
  const offPermission = sdk.event.on("permission.asked", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    if (!sysInfo().hasVoice) return
    const q = getQueue()
    if (!q) return
    q.cancel()
    queueIdle = false
    setSpeaking(true)
    q.push(`Permission needed for ${evt.properties.permission}. `)
    q.flush()
  })

  // Announce question prompts
  const offQuestion = sdk.event.on("question.asked", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    if (!sysInfo().hasVoice) return
    const q = getQueue()
    if (!q) return
    q.cancel()
    queueIdle = false
    setSpeaking(true)
    const question = evt.properties.questions?.[0]?.question
    if (question) {
      q.push(question + " ")
      q.flush()
    }
  })

  function cancel() {
    queue?.cancel()
    Speaker.cancel()
    queueIdle = true
    setSpeaking(false)
  }

  onCleanup(() => {
    queue?.cancel()
    offPart()
    offStatus()
    offPermission()
    offQuestion()
  })

  return { speaking, cancel, enabled }
}
