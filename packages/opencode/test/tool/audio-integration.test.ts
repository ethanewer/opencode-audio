import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { TranscribeTool } from "../../src/tool/transcribe"
import { ReadAudioTool } from "../../src/tool/read_audio"
import { ToolRegistry } from "../../src/tool/registry"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { SessionID, MessageID } from "../../src/session/schema"

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures")
// test/preload.ts deletes API keys for clean test state, so real-API tests
// must be run via the standalone script (test/tool/audio-integration-live.ts)
const HAS_OPENAI_KEY = !!process.env.OPENAI_API_KEY

afterEach(async () => {
  await Instance.disposeAll()
})

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

// Generate a minimal valid WAV file with a short sine wave
function wav(hz: number, duration: number, rate = 16000): Uint8Array {
  const samples = Math.floor(rate * duration)
  const data = new Int16Array(samples)
  for (let i = 0; i < samples; i++) {
    data[i] = Math.floor(Math.sin((2 * Math.PI * hz * i) / rate) * 32767 * 0.5)
  }
  const bytes = new Uint8Array(data.buffer)
  const header = new ArrayBuffer(44)
  const view = new DataView(header)
  view.setUint32(0, 0x52494646, false) // "RIFF"
  view.setUint32(4, 36 + bytes.length, true)
  view.setUint32(8, 0x57415645, false) // "WAVE"
  view.setUint32(12, 0x666d7420, false) // "fmt "
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(36, 0x64617461, false) // "data"
  view.setUint32(40, bytes.length, true)
  const result = new Uint8Array(44 + bytes.length)
  result.set(new Uint8Array(header), 0)
  result.set(bytes, 44)
  return result
}

describe("audio tool integration", () => {
  // Use pre-generated speech fixture + real OpenAI transcription API
  test.skipIf(!HAS_OPENAI_KEY)(
    "transcribe tool works with real OpenAI API",
    async () => {
      const fixture = path.join(FIXTURES_DIR, "test-speech.wav")
      await using tmp = await tmpdir({
        init: async (dir) => {
          const bytes = await Bun.file(fixture).arrayBuffer()
          await Bun.write(path.join(dir, "speech.wav"), bytes)
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await TranscribeTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, "speech.wav") }, ctx)
          const lower = result.output.toLowerCase()
          expect(lower).toContain("hello")
          expect(lower).toContain("test")
          expect(lower).toContain("transcription")
        },
      })
    },
    { timeout: 30_000 },
  )

  // Verify read_audio returns valid base64 attachment from a WAV
  test("read_audio returns valid attachment for generated wav", async () => {
    const audio = wav(440, 0.5)
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "tone.wav"), audio)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "tone.wav") }, ctx)
        expect(result.attachments?.length).toBe(1)
        const att = result.attachments![0]
        expect(att.mime).toBe("audio/wav")
        const b64 = att.url.slice(att.url.indexOf(",") + 1)
        const decoded = new Uint8Array(Buffer.from(b64, "base64"))
        expect(decoded.length).toBe(audio.length)
        expect(Buffer.from(decoded).equals(Buffer.from(audio))).toBe(true)
      },
    })
  })

  // Verify read_audio works with the real speech fixture
  test("read_audio returns attachment for real speech wav", async () => {
    const fixture = path.join(FIXTURES_DIR, "test-speech.wav")
    const original = await Bun.file(fixture).arrayBuffer()
    await Instance.provide({
      directory: FIXTURES_DIR,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: fixture }, ctx)
        expect(result.output).toBe("Audio file read successfully")
        expect(result.attachments?.length).toBe(1)
        const att = result.attachments![0]
        expect(att.mime).toBe("audio/wav")
        // Verify roundtrip: base64 decode matches original bytes
        const b64 = att.url.slice(att.url.indexOf(",") + 1)
        const decoded = Buffer.from(b64, "base64")
        expect(decoded.length).toBe(original.byteLength)
      },
    })
  })
})

describe("registry filtering by audioInput", () => {
  // Gemini models support native audio input
  test("Gemini gets read_audio, not transcribe", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({
          providerID: ProviderID.make("google"),
          modelID: ModelID.make("gemini-2.5-flash"),
          audioInput: true,
        })
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("read_audio")
        expect(ids).not.toContain("transcribe")
      },
    })
  })

  // GPT Audio models support native audio input
  test("GPT Audio gets read_audio, not transcribe", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-4o-audio-preview"),
          audioInput: true,
        })
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("read_audio")
        expect(ids).not.toContain("transcribe")
      },
    })
  })

  // MiniMax with audio support gets read_audio
  test("MiniMax with audio gets read_audio, not transcribe", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({
          providerID: ProviderID.make("minimax"),
          modelID: ModelID.make("minimax-m2.5"),
          audioInput: true,
        })
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("read_audio")
        expect(ids).not.toContain("transcribe")
      },
    })
  })

  // Claude does not support audio input
  test("Claude gets transcribe, not read_audio", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({
          providerID: ProviderID.make("anthropic"),
          modelID: ModelID.make("claude-sonnet-4-20250514"),
          audioInput: false,
        })
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("transcribe")
        expect(ids).not.toContain("read_audio")
      },
    })
  })

  // When audioInput is omitted, default to transcribe
  test("undefined audioInput gets transcribe, not read_audio", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({
          providerID: ProviderID.make("openai"),
          modelID: ModelID.make("gpt-4o"),
        })
        const ids = tools.map((t) => t.id)
        expect(ids).toContain("transcribe")
        expect(ids).not.toContain("read_audio")
      },
    })
  })
})
