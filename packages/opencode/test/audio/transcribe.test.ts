import { describe, test, expect, mock, beforeEach, afterAll } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

let lastModel: string | undefined

// Set required env var for the module
process.env.OPENAI_API_KEY = "test-key"

const origFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = origFetch
})
beforeEach(() => {
  lastModel = undefined
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body as FormData
    lastModel = body?.get("model") as string
    const audioFile = body?.get("file") as File
    const bytes = audioFile ? new Uint8Array(await audioFile.arrayBuffer()) : new Uint8Array()
    return new Response(
      JSON.stringify({
        text: `transcribed ${bytes.length} bytes`,
        usage: {
          type: "tokens",
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )
  }) as unknown as typeof fetch
})

const { transcribe, transcribeFile } = await import("../../src/audio/transcribe")

describe("audio.transcribe", () => {
  test("transcribe returns text from audio bytes", async () => {
    const audio = new Uint8Array([1, 2, 3])
    const text = await transcribe(audio)
    expect(text).toBe("transcribed 3 bytes")
  })

  test("transcribe uses default model when none specified", async () => {
    await transcribe(new Uint8Array([1]))
    expect(lastModel).toContain("gpt-4o-mini-transcribe")
  })

  test("transcribe uses custom model when specified", async () => {
    await transcribe(new Uint8Array([1]), "whisper-1")
    expect(lastModel).toContain("whisper-1")
  })

  test("transcribeFile reads wav and transcribes", async () => {
    await using tmp = await tmpdir()
    const wav = path.join(tmp.path, "test.wav")
    await Bun.write(wav, new Uint8Array([82, 73, 70, 70]))
    const text = await transcribeFile(wav)
    expect(text).toBe("transcribed 4 bytes")
  })

  test("transcribeFile passes model through", async () => {
    await using tmp = await tmpdir()
    const wav = path.join(tmp.path, "test.wav")
    await Bun.write(wav, new Uint8Array([1]))
    await transcribeFile(wav, "custom-model")
    expect(lastModel).toContain("custom-model")
  })

  test("transcribe handles empty audio", async () => {
    const text = await transcribe(new Uint8Array([]))
    expect(text).toBe("transcribed 0 bytes")
  })

  test("transcribe uses default model when passed undefined", async () => {
    await transcribe(new Uint8Array([1]), undefined)
    expect(lastModel).toContain("gpt-4o-mini-transcribe")
  })

  test("transcribeFile rejects for nonexistent file", async () => {
    expect(transcribeFile("/tmp/nonexistent-audio-file-12345.wav")).rejects.toThrow()
  })

  test("transcribe returns string type", async () => {
    const result = await transcribe(new Uint8Array([1, 2]))
    expect(typeof result).toBe("string")
  })

  test("transcribeFile reads full file content", async () => {
    await using tmp = await tmpdir()
    const wav = path.join(tmp.path, "large.wav")
    const data = new Uint8Array(1024)
    data.fill(42)
    await Bun.write(wav, data)
    const text = await transcribeFile(wav)
    expect(text).toBe("transcribed 1024 bytes")
  })

  test("transcribe calls onUsage with token counts", async () => {
    let usage: any
    await transcribe(new Uint8Array([1, 2, 3]), undefined, {
      onUsage: (u) => {
        usage = u
      },
    })
    expect(usage).toBeDefined()
    expect(usage.input_tokens).toBe(10)
    expect(usage.output_tokens).toBe(5)
    expect(usage.total_tokens).toBe(15)
  })
})
