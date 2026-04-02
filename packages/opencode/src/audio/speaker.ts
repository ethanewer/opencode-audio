// Singleton timing tracker for the speak tool.
// Estimates speech duration from text length and playback speed,
// enabling the tool to decide whether to queue or error.

const CHARS_PER_SEC = 11
const MIN_DURATION_MS = 1000

interface Entry {
  start: number
  end: number
}

const entries: Entry[] = []
let cancelled = false

function prune() {
  const now = Date.now()
  while (entries.length > 0 && entries[0].end <= now) entries.shift()
}

export function remaining(speed: number): number {
  if (cancelled) return 0
  prune()
  if (entries.length === 0) return 0
  const last = entries[entries.length - 1]
  return Math.max(0, (last.end - Date.now()) / 1000)
}

export function submit(text: string, speed: number) {
  if (cancelled) {
    entries.length = 0
    cancelled = false
  }
  prune()
  const duration = Math.max(MIN_DURATION_MS, (text.length / (CHARS_PER_SEC * speed)) * 1000)
  const now = Date.now()
  const start = entries.length > 0 ? entries[entries.length - 1].end : now
  entries.push({ start, end: start + duration })
}

export function cancel() {
  entries.length = 0
  cancelled = true
}
