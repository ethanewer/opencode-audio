import { createSignal, onCleanup, createEffect, createMemo } from "solid-js"
import { record } from "@/audio/record"
import { transcribe as transcribeLocal } from "@/audio/transcribe"
import { useSync } from "@tui/context/sync"
import { useToast } from "@tui/ui/toast"
import { useSDK } from "@tui/context/sdk"

const transcribeTimeoutMs = 120_000

export function useVoice(opts: { onResult: (text: string) => void }) {
  const sync = useSync()
  const sdk = useSDK()
  const toast = useToast()
  const [rec, setRec] = createSignal<ReturnType<typeof record> | null>(null)
  const [transcribing, setTranscribing] = createSignal(false)
  let active = true
  let transcribeAbort: AbortController | undefined

  const busy = createMemo(() => transcribing() || !!rec())
  const recording = createMemo(() => !!rec())

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  const [tick, setTick] = createSignal(0)
  let timer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    if (rec()) {
      setTick(0)
      timer = setInterval(() => setTick((t) => t + 1), 80)
    } else {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  })
  onCleanup(() => {
    if (timer) clearInterval(timer)
  })

  onCleanup(() => {
    active = false
    setTranscribing(false)
    const r = rec()
    if (r) {
      r.stop()
      setRec(null)
    }
  })

  function toggle() {
    if (transcribing()) return
    const r = rec()
    if (r) {
      setRec(null)
      setTranscribing(true)
      const abort = new AbortController()
      transcribeAbort = abort
      r.stop()
        .then(async (audio) => {
          if (abort.signal.aborted) return
          const model = sync.data.config.experimental?.voice?.model
          const pending = sdk.transcribe?.({ audio, model }) ?? transcribeLocal(audio, model)
          const text = await Promise.race([
            pending,
            new Promise<never>((_, reject) => {
              const t = setTimeout(
                () => reject(new Error("Transcription timed out")),
                transcribeTimeoutMs,
              )
              t.unref?.()
              abort.signal.addEventListener("abort", () => {
                clearTimeout(t)
                reject(new Error("Transcription cancelled"))
              })
            }),
          ])
          if (!active) return
          if (!text.trim()) return
          opts.onResult(text)
        })
        .catch((err) => {
          if (!active || abort.signal.aborted) return
          toast.show({
            variant: "error",
            title: "Transcription failed",
            message: err instanceof Error ? err.message : "An unknown error occurred",
            duration: 5000,
          })
        })
        .finally(() => {
          setTranscribing(false)
        })
    } else {
      try {
        setRec(record())
      } catch (err) {
        toast.show({
          variant: "error",
          message: err instanceof Error ? err.message : "Failed to start recording",
          duration: 3000,
        })
      }
    }
  }

  function cancel() {
    if (transcribeAbort) {
      transcribeAbort.abort()
      transcribeAbort = undefined
      setTranscribing(false)
    }
    const r = rec()
    if (r) {
      r.stop()
      setRec(null)
    }
  }

  function placeholder() {
    if (transcribing()) return "Transcribing..."
    if (rec()) {
      const elapsed = Math.floor((tick() * 80) / 1000)
      const min = String(Math.floor(elapsed / 60)).padStart(2, "0")
      const sec = String(elapsed % 60).padStart(2, "0")
      return `${frames[tick() % frames.length]} Recording ${min}:${sec} — press space to stop`
    }
    return "Press space to record"
  }

  return { recording, transcribing, busy, toggle, cancel, placeholder }
}
