import { createSignal, onCleanup } from "solid-js"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { SpeechQueue } from "@/audio/speech-queue"
import { StatusSpeaker } from "@/audio/status-speaker"

const VOICE_AGENTS = new Set(["voice-build", "voice-plan"])

export function useSpeech(sessionID: () => string) {
  const sdk = useSDK()
  const sync = useSync()

  const ttsConfig = () => sync.data.config.experimental?.voice?.tts
  const enabled = () => !!(sync.data.config.experimental?.voice?.enabled && ttsConfig()?.enabled)

  const [speaking, setSpeaking] = createSignal(false)

  let queue: SpeechQueue | null = null
  let statusSpeaker: StatusSpeaker | null = null

  // Step tracking state
  let stepHasTools = false
  let stepBuffer = ""
  let streaming = false

  // Mute flag: set when user cancels during generation, suppresses new speech
  let muted = false
  // Track which message we committed to speaking (skip others while speaking)
  let spokenMessageID: string | undefined
  // Idle tracking for speaking signal
  let queueIdle = true
  let statusIdle = true

  function checkIdle() {
    if (queueIdle && statusIdle) setSpeaking(false)
  }

  function getQueue() {
    if (!sdk.speak || !enabled()) return null
    if (!queue) {
      const config = ttsConfig()
      queue = new SpeechQueue({
        speak: sdk.speak,
        model: config?.model,
        voice: config?.voice,
        speed: config?.speed,
        onIdle: () => {
          queueIdle = true
          checkIdle()
        },
      })
    }
    return queue
  }

  function getStatus() {
    if (!sdk.speak || !enabled()) return null
    if (!statusSpeaker) {
      const config = ttsConfig()
      statusSpeaker = new StatusSpeaker({
        speak: sdk.speak,
        model: config?.model,
        voice: config?.voice,
        speed: config?.speed,
        onIdle: () => {
          statusIdle = true
          checkIdle()
        },
      })
    }
    return statusSpeaker
  }

  function voiceMessage() {
    const messages = sync.data.message[sessionID()] ?? []
    const last = messages.findLast((m) => m.role === "assistant")
    if (!last) return undefined
    if (!VOICE_AGENTS.has(last.agent)) return undefined
    return last
  }

  // Text deltas: stream to queue optimistically, also buffer for status routing
  const offDelta = sdk.event.on("message.part.delta", (evt) => {
    if (!enabled()) return
    if (evt.properties.field !== "text") return
    if (evt.properties.sessionID !== sessionID()) return
    const msg = voiceMessage()
    if (!msg || evt.properties.messageID !== msg.id) return

    // If currently speaking a different message, skip this one entirely
    if (speaking() && spokenMessageID && spokenMessageID !== msg.id) return

    // New message — commit to it and reset step state
    if (msg.id !== spokenMessageID) {
      spokenMessageID = msg.id
      muted = false
      stepHasTools = false
      stepBuffer = ""
      streaming = false
    }

    stepBuffer += evt.properties.delta

    // If muted (user pressed stop) or step has tools, don't stream
    if (muted || stepHasTools) return

    // Stream optimistically to the queue
    statusSpeaker?.cancel()
    const q = getQueue()
    if (!q) return
    queueIdle = false
    setSpeaking(true)
    streaming = true
    q.push(evt.properties.delta)
  })

  // Detect tool parts and step boundaries
  const offPart = sdk.event.on("message.part.updated", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    const msg = voiceMessage()
    if (!msg) return
    const part = evt.properties.part
    if (part.messageID !== msg.id) return

    if (part.type === "tool") {
      if (!stepHasTools && streaming) {
        // Tool appeared after we started streaming text — cancel the queue
        queue?.cancel()
        streaming = false
      }
      stepHasTools = true
    } else if (part.type === "step-finish") {
      if (!muted && stepHasTools && stepBuffer.trim() && ttsConfig()?.status !== false) {
        statusIdle = false
        setSpeaking(true)
        getStatus()?.speak(stepBuffer.trim())
      }
      stepHasTools = false
      stepBuffer = ""
      streaming = false
    }
  })

  // Flush remaining text when session goes idle
  const offSessionStatus = sdk.event.on("session.status", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    if (evt.properties.status.type !== "idle") return

    if (!muted) {
      const msg = voiceMessage()

      // If the final message was skipped (we were speaking an earlier one), speak it now
      if (msg && spokenMessageID && msg.id !== spokenMessageID) {
        const parts = sync.data.part[msg.id] ?? []
        const text = parts
          .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
          .map((p) => (p as { text: string }).text)
          .join("\n")
          .trim()
        if (text) {
          const q = getQueue()
          if (q) {
            queueIdle = false
            setSpeaking(true)
            q.push(text)
            q.flush()
          }
        }
      } else {
        // Normal case: flush status text and streamed queue
        if (stepHasTools && stepBuffer.trim() && ttsConfig()?.status !== false) {
          statusIdle = false
          setSpeaking(true)
          getStatus()?.speak(stepBuffer.trim())
        }
        if (queue) {
          queue.flush()
        }
      }
    }

    stepHasTools = false
    stepBuffer = ""
    streaming = false
    muted = false
    spokenMessageID = undefined
  })

  const offPermission = sdk.event.on("permission.asked", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    if (!voiceMessage()) return
    const q = getQueue()
    if (!q) return
    q.cancel()
    statusSpeaker?.cancel()
    muted = false
    queueIdle = false
    setSpeaking(true)
    q.push(`Permission needed for ${evt.properties.permission}. `)
    q.flush()
  })

  const offQuestion = sdk.event.on("question.asked", (evt) => {
    if (!enabled()) return
    if (evt.properties.sessionID !== sessionID()) return
    if (!voiceMessage()) return
    const q = getQueue()
    if (!q) return
    q.cancel()
    statusSpeaker?.cancel()
    muted = false
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
    statusSpeaker?.cancel()
    muted = true
    queueIdle = true
    statusIdle = true
    stepHasTools = false
    stepBuffer = ""
    streaming = false
    spokenMessageID = undefined
    setSpeaking(false)
  }

  onCleanup(() => {
    queue?.cancel()
    statusSpeaker?.cancel()
    offDelta()
    offPart()
    offSessionStatus()
    offPermission()
    offQuestion()
  })

  return { speaking, cancel, enabled }
}
