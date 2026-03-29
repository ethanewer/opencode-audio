import { createSignal, onCleanup, createEffect, createMemo } from "solid-js"
import { t, fg, bold, dim, type ColorInput } from "@opentui/core"
import { record } from "@/audio/record"
import { transcribe as transcribeLocal } from "@/audio/transcribe"
import { useSync } from "@tui/context/sync"
import { useToast } from "@tui/ui/toast"
import { useSDK } from "@tui/context/sdk"

const transcribeTimeoutMs = 120_000

export function useVoice(opts: {
  onResult: (text: string) => void
  audioInput?: () => boolean
  onAudio?: (audio: Uint8Array) => void
  color: ColorInput
}) {
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
      if (opts.audioInput?.() && opts.onAudio) {
        r.stop()
          .then((audio) => {
            if (!active) return
            opts.onAudio!(audio)
          })
          .catch((err) => {
            if (!active) return
            toast.show({
              variant: "error",
              title: "Recording failed",
              message: err instanceof Error ? err.message : "An unknown error occurred",
              duration: 5000,
            })
          })
      } else {
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
                const timer = setTimeout(() => reject(new Error("Transcription timed out")), transcribeTimeoutMs)
                timer.unref?.()
                abort.signal.addEventListener("abort", () => {
                  clearTimeout(timer)
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
      }
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
    const icon = fg(opts.color)(bold("◉"))
    if (transcribing()) return t`${icon} ${dim("Transcribing...")}`
    if (rec()) {
      const elapsed = Math.floor((tick() * 80) / 1000)
      const min = String(Math.floor(elapsed / 60)).padStart(2, "0")
      const sec = String(elapsed % 60).padStart(2, "0")
      return t`${icon} ${fg(opts.color)(frames[tick() % frames.length])} ${fg(opts.color)(`Recording ${min}:${sec}`)} ${dim("— press space to stop")}`
    }
    return t`${icon} ${dim("Press space to record")}`
  }

  return { recording, transcribing, busy, toggle, cancel, placeholder }
}
