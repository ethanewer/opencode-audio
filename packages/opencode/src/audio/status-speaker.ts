import { speakStream, playStream } from "./speak"

interface StatusSpeakerOptions {
  model?: string
  voice?: string
  speed?: number
  onIdle?: () => void
}

export class StatusSpeaker {
  private busy = false
  private abort: AbortController | null = null
  private player: ReturnType<typeof playStream> | null = null
  private model?: string
  private voice?: string
  private speed?: number
  private onIdle?: () => void

  constructor(options: StatusSpeakerOptions) {
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
    speakStream(text, { model: this.model, voice: this.voice, abortSignal: abort.signal })
      .then(async (stream) => {
        if (abort.signal.aborted) return
        const p = playStream(stream, { speed: this.speed })
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
