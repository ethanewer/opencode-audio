import { createSignal, onCleanup } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { SpeechQueue } from "@/audio/speech-queue"

export function useSpeech(sessionID: () => string) {
  const sdk = useSDK()
  const sync = useSync()

  const ttsConfig = () => sync.data.config.experimental?.voice?.tts
  const enabled = () => !!(sync.data.config.experimental?.voice?.enabled && ttsConfig()?.enabled)

  const [speaking, setSpeaking] = createSignal(false)

  let queue: SpeechQueue | null = null

  function getQueue() {
    if (!sdk.speak || !enabled()) return null
    if (!queue) {
      const config = ttsConfig()
      queue = new SpeechQueue({
        speak: sdk.speak,
        model: config?.model,
        voice: config?.voice,
        speed: config?.speed,
      })
    }
    return queue
  }

  // Speak the final assistant text when the session goes idle
  const offStatus = sdk.event.on("session.status", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    if (evt.properties.status.type !== "idle") return

    const messages = sync.data.message[sessionID()] ?? []
    const last = messages.findLast((m) => m.role === "assistant")
    if (!last) return

    const parts = sync.data.part[last.id] ?? []
    const textParts = parts.filter((p) => p.type === "text")
    const text = textParts.map((p) => p.text).join("\n").trim()
    if (!text) return

    const q = getQueue()
    if (!q) return
    setSpeaking(true)
    q.push(text)
    q.flush()
  })

  const offPermission = sdk.event.on("permission.asked", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    const q = getQueue()
    if (!q) return
    queue?.cancel()
    setSpeaking(true)
    q.push(`Permission needed for ${evt.properties.permission}. `)
    q.flush()
  })

  const offQuestion = sdk.event.on("question.asked", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    const q = getQueue()
    if (!q) return
    queue?.cancel()
    setSpeaking(true)
    const question = evt.properties.questions?.[0]?.question
    if (question) {
      q.push(question + " ")
      q.flush()
    }
  })

  function cancel() {
    queue?.cancel()
    setSpeaking(false)
  }

  onCleanup(() => {
    queue?.cancel()
    offStatus()
    offPermission()
    offQuestion()
  })

  return { speaking, cancel, enabled }
}
