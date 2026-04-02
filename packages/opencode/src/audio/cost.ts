// In-memory per-session audio cost accumulator.
// Tracks audio input (transcription / native) and audio output (TTS / native)
// costs separately from the main LLM text cost.

// gpt-4o-mini-tts audio codec: ~73.5 output tokens per second of PCM audio
// PCM format: 24kHz, 16-bit, mono = 48000 bytes per second
export const TTS_OUTPUT_TOKENS_PER_SEC = 73.5
export const PCM_BYTES_PER_SEC = 48000

type Entry = {
  input: number
  output: number
}

const costs = new Map<string, Entry>()
const listeners = new Set<() => void>()

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function add(id: string, type: "input" | "output", amount: number) {
  const entry = costs.get(id) ?? { input: 0, output: 0 }
  entry[type] += amount
  costs.set(id, entry)
  for (const fn of listeners) fn()
}

export function get(id: string): Entry {
  return costs.get(id) ?? { input: 0, output: 0 }
}

export function clear(id: string) {
  costs.delete(id)
}
