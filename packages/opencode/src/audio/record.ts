import { which } from "bun"

export function cmd() {
  if (which("rec")) return ["rec", "-q", "-t", "wav", "-"]
  if (which("ffmpeg")) {
    const base = ["-loglevel", "quiet", "-f"]
    if (process.platform === "darwin") return ["ffmpeg", ...base, "avfoundation", "-i", ":default", "-f", "wav", "-ac", "1", "-ar", "16000", "pipe:1"]
    return ["ffmpeg", ...base, "pulse", "-i", "default", "-f", "wav", "-ac", "1", "-ar", "16000", "pipe:1"]
  }
  throw new Error("ffmpeg or sox is required for voice recording. Install with: brew install ffmpeg")
}

export function record() {
  const proc = Bun.spawn(cmd(), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  // Collect stdout chunks while recording so we don't have to read
  // after SIGTERM — on macOS the pipe can hang if read post-kill.
  const chunks: Uint8Array[] = []
  const stdoutReader = proc.stdout.getReader()
  const reader = (async () => {
    while (true) {
      const { done, value } = await stdoutReader.read()
      if (done) break
      chunks.push(value)
    }
  })()

  return {
    async stop() {
      proc.kill("SIGTERM")
      await proc.exited
      await reader.catch(() => {})
      let total = 0
      for (const c of chunks) total += c.length
      const buf = new Uint8Array(total)
      let offset = 0
      for (const c of chunks) {
        buf.set(c, offset)
        offset += c.length
      }
      return buf
    },
  }
}
