import { describe, test, expect, mock } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"

let lastModel: string | undefined
mock.module("ai", () => ({
  experimental_transcribe: async (opts: { model: { modelId: string }; audio: Uint8Array }) => {
    lastModel = opts.model.modelId
    return { text: `transcribed ${opts.audio.length} bytes` }
  },
}))

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
})
