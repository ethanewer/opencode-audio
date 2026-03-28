import { play } from "./speak"
import type { SpeakFn } from "./speech-queue"

interface StatusSpeakerOptions {
  speak: SpeakFn
  model?: string
  voice?: string
  speed?: number
  onIdle?: () => void
}

export class StatusSpeaker {
  private busy = false
  private abort: AbortController | null = null
  private player: ReturnType<typeof play> | null = null
  private speakFn: SpeakFn
  private model?: string
  private voice?: string
  private speed?: number
  private onIdle?: () => void

  constructor(options: StatusSpeakerOptions) {
    this.speakFn = options.speak
    this.model = options.model
    this.voice = options.voice
    this.speed = options.speed
    this.onIdle = options.onIdle
  }

  speak(text: string) {
    if (this.busy) return
    this.busy = true
    const abort = new AbortController()
    this.abort = abort
    this.speakFn({ text, model: this.model, voice: this.voice })
      .then(async (base64) => {
        if (abort.signal.aborted) return
        const audio = new Uint8Array(Buffer.from(base64, "base64"))
        if (audio.length === 0 || abort.signal.aborted) return
        const p = play(audio, { speed: this.speed })
        this.player = p
        await p.done
      })
      .catch(() => {})
      .finally(() => {
        if (this.abort === abort) {
          this.busy = false
          this.abort = null
          this.player = null
          this.onIdle?.()
        }
      })
  }

  cancel() {
    if (this.abort) {
      this.abort.abort()
      this.abort = null
    }
    if (this.player) {
      this.player.stop()
      this.player = null
    }
    this.busy = false
  }
}
