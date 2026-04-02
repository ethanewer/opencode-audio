import { speakStream, playStream } from "./speak"

export interface SpeechQueueOptions {
  model?: string
  voice?: string
  speed?: number
  onIdle?: () => void
  onBytes?: (bytes: number) => void
}

export class SpeechQueue {
  private buffer = ""
  private queue: Array<{ stream: Promise<ReadableStream<Uint8Array>>; abort: AbortController }> = []
  private playing: ReturnType<typeof playStream> | null = null
  private processing = false
  private generation = 0
  private model?: string
  private voice?: string
  private speed?: number
  private onIdle?: () => void
  private onBytes?: (bytes: number) => void

  constructor(options: SpeechQueueOptions) {
    this.model = options.model
    this.voice = options.voice
    this.speed = options.speed
    this.onIdle = options.onIdle
    this.onBytes = options.onBytes
  }

  push(text: string) {
    this.buffer += text
    this.drainBuffer(false)
  }

  flush() {
    this.drainBuffer(true)
  }

  cancel() {
    this.generation++
    this.buffer = ""
    for (const item of this.queue) {
      item.abort.abort()
    }
    this.queue = []
    if (this.playing) {
      this.playing.stop()
      this.playing = null
    }
    this.processing = false
  }

  private drainBuffer(force: boolean) {
    const sentences = splitSentences(this.buffer, force)
    for (const sentence of sentences.complete) {
      const cleaned = sanitize(sentence)
      if (cleaned.trim()) {
        this.enqueue(cleaned)
      }
    }
    this.buffer = sentences.remaining
  }

  private enqueue(text: string) {
    const abort = new AbortController()
    const stream = speakStream(text, {
      model: this.model,
      voice: this.voice,
      abortSignal: abort.signal,
    }).catch(
      () =>
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close()
          },
        }),
    )
    this.queue.push({ stream, abort })
    if (!this.processing) {
      this.processQueue()
    }
  }

  private async processQueue() {
    this.processing = true
    const gen = this.generation
    while (this.queue.length > 0 && this.generation === gen) {
      const item = this.queue[0]
      const raw = await item.stream
      if (this.generation !== gen) break
      this.queue.shift()
      if (item.abort.signal.aborted) continue
      // Wrap stream to count PCM bytes for cost tracking
      let bytes = 0
      const counted = this.onBytes
        ? raw.pipeThrough(
            new TransformStream<Uint8Array, Uint8Array>({
              transform(chunk, ctrl) {
                bytes += chunk.length
                ctrl.enqueue(chunk)
              },
            }),
          )
        : raw
      const player = playStream(counted, { speed: this.speed })
      this.playing = player
      await player.done
      if (bytes > 0) this.onBytes?.(bytes)
      if (this.generation !== gen) break
      this.playing = null
    }
    if (this.generation === gen) {
      this.processing = false
      this.onIdle?.()
    }
  }
}

function splitSentences(text: string, force: boolean): { complete: string[]; remaining: string } {
  const complete: string[] = []
  let remaining = text
  let accumulated = ""

  while (true) {
    const match = remaining.match(/[.!?]\s+|\n\n/)
    if (!match || match.index === undefined) break

    const end = match.index + match[0].length
    const fragment = remaining.slice(0, end)
    remaining = remaining.slice(end)
    accumulated += fragment

    // Only emit once we have enough text to be worth speaking
    if (accumulated.trim().length >= 40) {
      complete.push(accumulated.trim())
      accumulated = ""
    }
  }

  // Put any leftover accumulated text back into remaining
  remaining = accumulated + remaining

  if (force && remaining.trim()) {
    complete.push(remaining.trim())
    remaining = ""
  }

  return { complete, remaining }
}

function sanitize(text: string): string {
  return (
    text
      // Remove code fences and their content, replace with "code block"
      .replace(/```[\s\S]*?```/g, "code block")
      // Remove inline code backticks
      .replace(/`([^`]+)`/g, "$1")
      // Remove markdown headers
      .replace(/^#{1,6}\s+/gm, "")
      // Remove markdown bold/italic
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
      .replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
      // Remove markdown images
      .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
      // Remove markdown links, keep text
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      // Collapse multiple whitespace
      .replace(/\s+/g, " ")
      .trim()
  )
}
