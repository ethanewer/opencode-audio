import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { Locale } from "@/util/locale"

export function DialogSystem() {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() =>
    local.system.list().map((entry) => {
      const info = local.system.infoFor(entry)
      const parts: string[] = []
      if (info.provider) parts.push(info.provider.name)
      if (info.hasTts) parts.push("TTS")
      if (info.transcription) parts.push("STT")
      if (info.hasAudioOutput) parts.push("Native Audio")
      const desc = parts.length ? parts.join(", ") : undefined
      return {
        value: entry.key,
        title: entry.label ?? Locale.titlecase(entry.key),
        description: desc,
      }
    }),
  )

  return (
    <DialogSelect
      title="Select system"
      current={local.system.current()?.key}
      options={options()}
      onSelect={(option) => {
        local.system.set(option.value)
        dialog.clear()
      }}
    />
  )
}
