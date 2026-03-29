// Side channel for audio output captured from gpt-audio model responses.
// The custom fetch wrapper in provider.ts stores audio here; processor.ts retrieves it.
// Keyed by a correlation ID (X-Audio-Correlation header) to avoid races between concurrent requests.

const pending = new Map<string, { data: string; transcript: string }>()

export function store(key: string, audio: { data: string; transcript: string }) {
  pending.set(key, audio)
}

export function take(key: string) {
  const result = pending.get(key)
  if (result) pending.delete(key)
  return result
}
