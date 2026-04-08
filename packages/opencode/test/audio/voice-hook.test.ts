import { describe, test, expect, mock, beforeEach } from "bun:test"
import { createRoot } from "solid-js"

let recordCalls = 0

mock.module("../../src/audio/record", () => ({
  record: () => {
    recordCalls++
    return {
      stop: () => Promise.resolve(new Uint8Array([1, 2, 3])),
    }
  },
}))

mock.module("ai", () => ({
  experimental_transcribe: async () => ({ text: "hello world" }),
}))

mock.module("../../src/cli/cmd/tui/context/sync", () => ({
  useSync: () => ({ data: { config: {} } }),
}))

mock.module("../../src/cli/cmd/tui/context/local", () => ({
  useLocal: () => ({ system: { current: () => undefined } }),
}))

mock.module("../../src/cli/cmd/tui/context/sdk", () => ({
  useSDK: () => ({ transcribe: undefined }),
}))

mock.module("../../src/cli/cmd/tui/ui/toast", () => ({
  useToast: () => ({ show: () => {} }),
}))

const { useVoice } = await import("../../src/cli/cmd/tui/util/voice")

const flush = () => new Promise((r) => setTimeout(r, 50))

describe("useVoice", () => {
  beforeEach(() => {
    recordCalls = 0
  })

  test("finish routes transcription to onFinish, not onResult", async () => {
    let result = ""
    let finished = ""
    let voice!: ReturnType<typeof useVoice>

    const dispose = createRoot((dispose) => {
      voice = useVoice({
        onResult: (text) => {
          result = text
        },
        onFinish: (text) => {
          finished = text
        },
        color: "white",
      })
      return dispose
    })

    voice.toggle()
    expect(voice.recording()).toBe(true)
    expect(voice.busy()).toBe(true)

    voice.finish()
    expect(voice.recording()).toBe(false)
    expect(voice.transcribing()).toBe(true)

    await flush()

    expect(finished).toBe("hello world")
    expect(result).toBe("")

    dispose()
  })

  test("toggle stop routes transcription to onResult, not onFinish", async () => {
    let result = ""
    let finished = ""
    let voice!: ReturnType<typeof useVoice>

    const dispose = createRoot((dispose) => {
      voice = useVoice({
        onResult: (text) => {
          result = text
        },
        onFinish: (text) => {
          finished = text
        },
        color: "white",
      })
      return dispose
    })

    voice.toggle()
    expect(voice.recording()).toBe(true)

    voice.toggle()
    expect(voice.recording()).toBe(false)
    expect(voice.transcribing()).toBe(true)

    await flush()

    expect(result).toBe("hello world")
    expect(finished).toBe("")

    dispose()
  })

  test("finish when not recording is a no-op", async () => {
    let finished = ""
    let voice!: ReturnType<typeof useVoice>

    const dispose = createRoot((dispose) => {
      voice = useVoice({
        onResult: () => {},
        onFinish: (text) => {
          finished = text
        },
        color: "white",
      })
      return dispose
    })

    expect(voice.recording()).toBe(false)
    voice.finish()

    await flush()

    expect(finished).toBe("")
    expect(recordCalls).toBe(0)

    dispose()
  })

  test("finish when transcribing is a no-op", async () => {
    let count = 0
    let voice!: ReturnType<typeof useVoice>

    const dispose = createRoot((dispose) => {
      voice = useVoice({
        onResult: () => {},
        onFinish: () => {
          count++
        },
        color: "white",
      })
      return dispose
    })

    voice.toggle()
    voice.finish()
    expect(voice.transcribing()).toBe(true)

    // calling finish again while transcribing should be a no-op
    voice.finish()

    await flush()

    expect(count).toBe(1)

    dispose()
  })

  test("cancel aborts transcription and resets state", async () => {
    let result = ""
    let finished = ""
    let voice!: ReturnType<typeof useVoice>

    const dispose = createRoot((dispose) => {
      voice = useVoice({
        onResult: (text) => {
          result = text
        },
        onFinish: (text) => {
          finished = text
        },
        color: "white",
      })
      return dispose
    })

    voice.toggle()
    voice.finish()
    expect(voice.transcribing()).toBe(true)

    voice.cancel()
    expect(voice.transcribing()).toBe(false)
    expect(voice.busy()).toBe(false)

    await flush()

    expect(result).toBe("")
    expect(finished).toBe("")

    dispose()
  })

  test("finish bypasses audio input path even when audioInput is true", async () => {
    let finished = ""
    let audio = false
    let voice!: ReturnType<typeof useVoice>

    const dispose = createRoot((dispose) => {
      voice = useVoice({
        onResult: () => {},
        onFinish: (text) => {
          finished = text
        },
        audioInput: () => true,
        onAudio: () => {
          audio = true
        },
        color: "white",
      })
      return dispose
    })

    voice.toggle()
    voice.finish()

    await flush()

    expect(finished).toBe("hello world")
    expect(audio).toBe(false)

    dispose()
  })
})
