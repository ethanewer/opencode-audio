// Singleton timing tracker for the speak tool.
// Estimates speech duration from text length and playback speed,
// enabling the tool to decide whether to queue or error.

const CHARS_PER_SEC = 15

interface Entry {
  start: number
  end: number
}

const entries: Entry[] = []

function prune() {
  const now = Date.now()
  while (entries.length > 0 && entries[0].end <= now) entries.shift()
}

export function remaining(speed: number): number {
  prune()
  if (entries.length === 0) return 0
  const last = entries[entries.length - 1]
  return Math.max(0, (last.end - Date.now()) / 1000)
}

export function submit(text: string, speed: number) {
  prune()
  const duration = (text.length / (CHARS_PER_SEC * speed)) * 1000
  const now = Date.now()
  const start = entries.length > 0 ? entries[entries.length - 1].end : now
  entries.push({ start, end: start + duration })
}

export function cancel() {
  entries.length = 0
}
