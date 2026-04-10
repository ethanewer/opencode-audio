import { describe, test, expect, beforeEach, mock } from "bun:test"
import {
  AsyncQueue,
  AsyncAudioQueue,
  splitSentences,
  sanitize,
  stt,
  tts,
  pcmToWav,
  createVoiceSession,
  voiceSystems,
  type VoiceSession,
  type VoiceSystem,
  type VoiceSystemName,
  type TtsOptions,
  type SttOptions,
  type PcmFormat,
} from "@opencode-ai/sdk/v2/voice"

// ---------------------------------------------------------------------------
// AsyncAudioQueue
// ---------------------------------------------------------------------------

describe("AsyncAudioQueue", () => {
  test("push and next in order", async () => {
    const q = new AsyncAudioQueue()
    q.push(new Uint8Array([1, 2]))
    q.push(new Uint8Array([3, 4]))
    const a = await q.next()
    const b = await q.next()
    expect(a.value).toEqual(new Uint8Array([1, 2]))
    expect(b.value).toEqual(new Uint8Array([3, 4]))
    expect(a.done).toBe(false)
    expect(b.done).toBe(false)
  })

  test("next waits for push", async () => {
    const q = new AsyncAudioQueue()
    const pending = q.next()
    q.push(new Uint8Array([5]))
    const result = await pending
    expect(result.value).toEqual(new Uint8Array([5]))
    expect(result.done).toBe(false)
  })

  test("close terminates pending next", async () => {
    const q = new AsyncAudioQueue()
    const pending = q.next()
    q.close()
    const result = await pending
    expect(result.done).toBe(true)
  })

  test("next after close returns done", async () => {
    const q = new AsyncAudioQueue()
    q.close()
    const result = await q.next()
    expect(result.done).toBe(true)
  })

  test("push after close is ignored", async () => {
    const q = new AsyncAudioQueue()
    q.push(new Uint8Array([1]))
    q.close()
    q.push(new Uint8Array([2]))
    const a = await q.next()
    expect(a.value).toEqual(new Uint8Array([1]))
    const b = await q.next()
    expect(b.done).toBe(true)
  })

  test("closed getter reflects state", () => {
    const q = new AsyncAudioQueue()
    expect(q.closed).toBe(false)
    q.close()
    expect(q.closed).toBe(true)
  })

  test("double close is safe", () => {
    const q = new AsyncAudioQueue()
    q.close()
    q.close()
    expect(q.closed).toBe(true)
  })

  test("async iteration yields items then terminates on close", async () => {
    const q = new AsyncAudioQueue()
    q.push(new Uint8Array([10]))
    q.push(new Uint8Array([20]))
    // Close after a tick so the iterator can drain
    setTimeout(() => q.close(), 10)
    const items: Uint8Array[] = []
    for await (const item of q) {
      items.push(item)
    }
    expect(items.length).toBe(2)
    expect(items[0]).toEqual(new Uint8Array([10]))
    expect(items[1]).toEqual(new Uint8Array([20]))
  })

  test("multiple pending next calls resolved in order", async () => {
    const q = new AsyncAudioQueue()
    const a = q.next()
    const b = q.next()
    q.push(new Uint8Array([1]))
    q.push(new Uint8Array([2]))
    expect((await a).value).toEqual(new Uint8Array([1]))
    expect((await b).value).toEqual(new Uint8Array([2]))
  })

  test("close resolves all pending next calls", async () => {
    const q = new AsyncAudioQueue()
    const a = q.next()
    const b = q.next()
    const c = q.next()
    q.close()
    expect((await a).done).toBe(true)
    expect((await b).done).toBe(true)
    expect((await c).done).toBe(true)
  })

  test("length getter tracks buffered items", async () => {
    const q = new AsyncAudioQueue()
    expect(q.length).toBe(0)
    q.push(new Uint8Array([1]))
    q.push(new Uint8Array([2]))
    expect(q.length).toBe(2)
    await q.next()
    expect(q.length).toBe(1)
    await q.next()
    expect(q.length).toBe(0)
  })

  test("length is 0 when items go directly to resolvers", async () => {
    const q = new AsyncAudioQueue()
    const pending = q.next()
    expect(q.length).toBe(0)
    q.push(new Uint8Array([1]))
    // Item went to resolver, not buffer
    expect(q.length).toBe(0)
    await pending
  })

  test("interleaved push and next", async () => {
    const q = new AsyncAudioQueue()
    q.push(new Uint8Array([1]))
    expect((await q.next()).value).toEqual(new Uint8Array([1]))
    const pending = q.next()
    q.push(new Uint8Array([2]))
    expect((await pending).value).toEqual(new Uint8Array([2]))
    q.push(new Uint8Array([3]))
    q.push(new Uint8Array([4]))
    expect((await q.next()).value).toEqual(new Uint8Array([3]))
    expect((await q.next()).value).toEqual(new Uint8Array([4]))
  })
})

// ---------------------------------------------------------------------------
// AsyncQueue (generic)
// ---------------------------------------------------------------------------

describe("AsyncQueue", () => {
  test("works with string type", async () => {
    const q = new AsyncQueue<string>()
    q.push("hello")
    q.push("world")
    const a = await q.next()
    const b = await q.next()
    expect(a.value).toBe("hello")
    expect(b.value).toBe("world")
    expect(a.done).toBe(false)
  })

  test("close terminates pending next", async () => {
    const q = new AsyncQueue<string>()
    const pending = q.next()
    q.close()
    const result = await pending
    expect(result.done).toBe(true)
  })

  test("async iteration yields items then terminates", async () => {
    const q = new AsyncQueue<string>()
    q.push("a")
    q.push("b")
    setTimeout(() => q.close(), 10)
    const items: string[] = []
    for await (const item of q) {
      items.push(item)
    }
    expect(items).toEqual(["a", "b"])
  })

  test("AsyncAudioQueue is a subclass of AsyncQueue", () => {
    const q = new AsyncAudioQueue()
    expect(q).toBeInstanceOf(AsyncQueue)
    expect(q).toBeInstanceOf(AsyncAudioQueue)
  })
})

// ---------------------------------------------------------------------------
// splitSentences
// ---------------------------------------------------------------------------

describe("splitSentences", () => {
  test("splits on period followed by space", () => {
    const result = splitSentences("This is a fairly long first sentence. And this is the second one. ", false)
    expect(result.complete.length).toBe(1)
    expect(result.complete[0]).toContain("first sentence")
    expect(result.complete[0]).toContain("second one")
  })

  test("splits on exclamation mark", () => {
    const result = splitSentences("Wow this is a really amazing sentence! And here is another one. ", false)
    expect(result.complete.length).toBeGreaterThanOrEqual(1)
  })

  test("splits on question mark", () => {
    const result = splitSentences("Is this sentence long enough to trigger a split? Yes it is. ", false)
    expect(result.complete.length).toBeGreaterThanOrEqual(1)
  })

  test("does not split short fragments", () => {
    const result = splitSentences("Hi. ", false)
    expect(result.complete.length).toBe(0)
    expect(result.remaining).toBe("Hi. ")
  })

  test("accumulates until minimum length", () => {
    const result = splitSentences("Ok. Fine. Sure. Whatever you say is correct. ", false)
    // Fragments are accumulated until >= 40 chars
    expect(result.complete.length).toBeGreaterThanOrEqual(1)
    for (const s of result.complete) {
      expect(s.length).toBeGreaterThanOrEqual(40)
    }
  })

  test("force flush emits remaining", () => {
    const result = splitSentences("short text", true)
    expect(result.complete).toEqual(["short text"])
    expect(result.remaining).toBe("")
  })

  test("force flush with empty text", () => {
    const result = splitSentences("", true)
    expect(result.complete).toEqual([])
    expect(result.remaining).toBe("")
  })

  test("no split without force on incomplete sentence", () => {
    const result = splitSentences("This is an incomplete sentence without ending punctuation", false)
    expect(result.complete).toEqual([])
    expect(result.remaining).toBe("This is an incomplete sentence without ending punctuation")
  })

  test("splits on double newline", () => {
    const text = "This is a paragraph that is long enough to split.\n\nAnd here is another one. "
    const result = splitSentences(text, false)
    expect(result.complete.length).toBeGreaterThanOrEqual(1)
  })

  test("handles multiple sentences in sequence", () => {
    const text =
      "First sentence is a long one that has many words in it. Second sentence is also a long one with many words. Third sentence too is long enough. "
    const result = splitSentences(text, false)
    expect(result.complete.length).toBeGreaterThanOrEqual(1)
  })

  test("custom minLength reduces threshold", () => {
    // "Hi. " is 3 chars — too short for default 40, but ok for minLength=1
    const result = splitSentences("Hi. ", false, 1)
    expect(result.complete.length).toBe(1)
    expect(result.complete[0]).toBe("Hi.")
  })

  test("custom minLength increases threshold", () => {
    // Default 40 would emit this, but minLength=100 won't
    const text = "This is a long enough sentence for default. "
    const result = splitSentences(text, false, 100)
    expect(result.complete.length).toBe(0)
    expect(result.remaining).toBe(text)
  })

  test("minLength 0 emits every sentence boundary", () => {
    const result = splitSentences("A. B. C. ", false, 0)
    expect(result.complete.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// sanitize
// ---------------------------------------------------------------------------

describe("sanitize", () => {
  test("removes code fences", () => {
    expect(sanitize("before ```code here``` after")).toBe("before code block after")
  })

  test("removes inline backticks", () => {
    expect(sanitize("use `foo` here")).toBe("use foo here")
  })

  test("removes markdown headers", () => {
    expect(sanitize("## Header text")).toBe("Header text")
    expect(sanitize("### Another header")).toBe("Another header")
  })

  test("removes bold markers", () => {
    expect(sanitize("this is **bold** text")).toBe("this is bold text")
  })

  test("removes italic markers", () => {
    expect(sanitize("this is *italic* text")).toBe("this is italic text")
  })

  test("removes markdown images, keeps alt text", () => {
    expect(sanitize("![alt text](http://example.com/img.png)")).toBe("alt text")
  })

  test("removes markdown links, keeps text", () => {
    expect(sanitize("[click here](http://example.com)")).toBe("click here")
  })

  test("collapses whitespace", () => {
    expect(sanitize("too   much    space")).toBe("too much space")
  })

  test("handles empty string", () => {
    expect(sanitize("")).toBe("")
  })

  test("handles plain text unchanged", () => {
    expect(sanitize("just normal text")).toBe("just normal text")
  })

  test("handles multiline code fences", () => {
    const input = "before\n```js\nconst x = 1\n```\nafter"
    expect(sanitize(input)).toBe("before code block after")
  })

  test("removes underscore emphasis", () => {
    expect(sanitize("this is _emphasized_ text")).toBe("this is emphasized text")
  })
})

// ---------------------------------------------------------------------------
// stt (speech-to-text)
// ---------------------------------------------------------------------------

describe("stt", () => {
  const original = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = original
  })

  test("calls OpenAI transcription endpoint", async () => {
    let captured: { url: string; method: string; auth: string } | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      captured = {
        url: req.url,
        method: req.method,
        auth: req.headers.get("Authorization") ?? "",
      }
      return new Response(JSON.stringify({ text: "hello world" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const result = await stt(new Uint8Array([1, 2, 3]), {
      apiKey: "test-key",
      baseUrl: "https://api.test.com/v1",
    })
    expect(result).toBe("hello world")
    expect(captured!.url).toContain("/audio/transcriptions")
    expect(captured!.method).toBe("POST")
    expect(captured!.auth).toBe("Bearer test-key")
  })

  test("throws on non-200 response", async () => {
    globalThis.fetch = (async () => {
      return new Response("bad request", { status: 400 })
    }) as any

    expect(stt(new Uint8Array([1]), { apiKey: "key", baseUrl: "https://api.test.com/v1" })).rejects.toThrow(
      "OpenAI STT error 400",
    )
  })

  test("sends audio as form data", async () => {
    let body: FormData | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      body = await req.formData()
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    await stt(new Uint8Array([1, 2, 3]), { apiKey: "key", baseUrl: "https://api.test.com/v1" })
    expect(body).toBeDefined()
    expect(body!.get("model")).toBe("gpt-4o-mini-transcribe")
    expect(body!.get("file")).toBeInstanceOf(Blob)
  })

  test("uses custom model", async () => {
    let body: FormData | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      body = await req.formData()
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    await stt(new Uint8Array([1]), {
      apiKey: "key",
      baseUrl: "https://api.test.com/v1",
      model: "whisper-1",
    })
    expect(body!.get("model")).toBe("whisper-1")
  })

  test("wraps raw PCM in WAV header when format is provided", async () => {
    let blob: Blob | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      const fd = await req.formData()
      blob = fd.get("file") as Blob
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const pcm = new Uint8Array([0, 1, 2, 3])
    await stt(pcm, {
      apiKey: "key",
      baseUrl: "https://api.test.com/v1",
      format: { sampleRate: 16000, channels: 1, bitDepth: 16 },
    })

    expect(blob).toBeDefined()
    // WAV = 44 byte header + 4 bytes PCM data
    expect(blob!.size).toBe(48)

    // Verify it starts with RIFF
    const bytes = new Uint8Array(await blob!.arrayBuffer())
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe("RIFF")
  })

  test("passes signal to fetch for cancellation", async () => {
    let captured: { signal: AbortSignal | null } | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      captured = { signal: req.signal }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const ctrl = new AbortController()
    await stt(new Uint8Array([1]), {
      apiKey: "key",
      baseUrl: "https://api.test.com/v1",
      signal: ctrl.signal,
    })
    expect(captured!.signal).toBeDefined()
  })

  test("sends raw buffer as-is when format is not provided", async () => {
    let blob: Blob | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      const fd = await req.formData()
      blob = fd.get("file") as Blob
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const audio = new Uint8Array([1, 2, 3])
    await stt(audio, { apiKey: "key", baseUrl: "https://api.test.com/v1" })

    // Without format, the 3-byte input should be sent directly (no WAV wrapping)
    expect(blob!.size).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// pcmToWav
// ---------------------------------------------------------------------------

describe("pcmToWav", () => {
  test("produces valid WAV header", () => {
    const pcm = new Uint8Array([0, 1, 2, 3])
    const wav = pcmToWav(pcm, { sampleRate: 16000, channels: 1, bitDepth: 16 })

    // WAV is 44 byte header + data
    expect(wav.length).toBe(44 + 4)

    // RIFF header
    expect(String.fromCharCode(wav[0], wav[1], wav[2], wav[3])).toBe("RIFF")
    // WAVE
    expect(String.fromCharCode(wav[8], wav[9], wav[10], wav[11])).toBe("WAVE")
    // fmt
    expect(String.fromCharCode(wav[12], wav[13], wav[14], wav[15])).toBe("fmt ")
    // data
    expect(String.fromCharCode(wav[36], wav[37], wav[38], wav[39])).toBe("data")

    // PCM data starts at offset 44
    expect(wav[44]).toBe(0)
    expect(wav[45]).toBe(1)
    expect(wav[46]).toBe(2)
    expect(wav[47]).toBe(3)
  })

  test("encodes sample rate in header", () => {
    const wav = pcmToWav(new Uint8Array([0]), { sampleRate: 24000, channels: 1, bitDepth: 16 })
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getUint32(24, true)).toBe(24000)
  })

  test("encodes channels in header", () => {
    const wav = pcmToWav(new Uint8Array([0, 0, 0, 0]), { sampleRate: 16000, channels: 2, bitDepth: 16 })
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
    expect(view.getUint16(22, true)).toBe(2)
  })

  test("handles empty PCM data", () => {
    const wav = pcmToWav(new Uint8Array([]), { sampleRate: 16000, channels: 1, bitDepth: 16 })
    expect(wav.length).toBe(44)
  })
})

// ---------------------------------------------------------------------------
// tts (text-to-speech)
// ---------------------------------------------------------------------------

describe("tts", () => {
  const original = globalThis.fetch

  beforeEach(() => {
    globalThis.fetch = original
  })

  test("calls OpenAI speech endpoint and returns stream", async () => {
    let captured: { url: string; body: any } | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      captured = { url: req.url, body: await req.json() }
      return new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 })
    }) as any

    const stream = await tts("hello", {
      apiKey: "test-key",
      baseUrl: "https://api.test.com/v1",
    })
    expect(stream).toBeInstanceOf(ReadableStream)
    expect(captured!.url).toContain("/audio/speech")
    expect(captured!.body.input).toBe("hello")
    expect(captured!.body.response_format).toBe("pcm")
  })

  test("uses custom model and voice", async () => {
    let captured: { body: any } | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      captured = { body: await req.json() }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as any

    await tts("hi", {
      apiKey: "key",
      baseUrl: "https://api.test.com/v1",
      model: "tts-1-hd",
      voice: "alloy",
    })
    expect(captured!.body.model).toBe("tts-1-hd")
    expect(captured!.body.voice).toBe("alloy")
  })

  test("throws on non-200 response", async () => {
    globalThis.fetch = (async () => {
      return new Response("error", { status: 500 })
    }) as any

    expect(tts("hello", { apiKey: "key", baseUrl: "https://api.test.com/v1" })).rejects.toThrow("OpenAI TTS error 500")
  })

  test("returns a readable stream from valid response", async () => {
    globalThis.fetch = (async () => {
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    }) as any

    const stream = await tts("hello", { apiKey: "key", baseUrl: "https://api.test.com/v1" })
    expect(stream).toBeInstanceOf(ReadableStream)
    // Read the stream to verify it contains the data
    const reader = stream.getReader()
    const { value } = await reader.read()
    expect(value).toEqual(new Uint8Array([1, 2, 3]))
    reader.releaseLock()
  })

  test("passes speed parameter when provided", async () => {
    let captured: { body: any } | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      captured = { body: await req.json() }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as any

    await tts("text", { apiKey: "key", baseUrl: "https://api.test.com/v1", speed: 1.5 })
    expect(captured!.body.speed).toBe(1.5)
  })

  test("omits speed parameter when not provided", async () => {
    let captured: { body: any } | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      captured = { body: await req.json() }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as any

    await tts("text", { apiKey: "key", baseUrl: "https://api.test.com/v1" })
    expect(captured!.body.speed).toBeUndefined()
  })

  test("defaults to coral voice and gpt-4o-mini-tts", async () => {
    let captured: { body: any } | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      captured = { body: await req.json() }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as any

    await tts("text", { apiKey: "key", baseUrl: "https://api.test.com/v1" })
    expect(captured!.body.model).toBe("gpt-4o-mini-tts")
    expect(captured!.body.voice).toBe("coral")
  })
})
describe("voiceSystems", () => {
  test("all built-in systems have valid model format", () => {
    for (const [name, sys] of Object.entries(voiceSystems)) {
      expect(sys.model).toContain("/")
      const [provider, ...rest] = sys.model.split("/")
      expect(provider.length).toBeGreaterThan(0)
      expect(rest.join("/").length).toBeGreaterThan(0)
    }
  })

  test("all systems with TTS have model and voice fields", () => {
    for (const [name, sys] of Object.entries(voiceSystems)) {
      const s = sys as VoiceSystem
      if (s.tts) {
        expect(s.tts.model).toBeDefined()
        expect(s.tts.voice).toBeDefined()
      }
    }
  })

  test("gpt-audio-voice has no TTS or transcription (native audio)", () => {
    const sys = voiceSystems["gpt-audio-voice"] as VoiceSystem
    expect(sys.tts).toBeUndefined()
    expect(sys.transcription).toBeUndefined()
  })

  test("claude systems have transcription configured", () => {
    expect(voiceSystems["claude-opus-medium-voice"].transcription).toBe("gpt-4o-mini-transcribe")
    expect(voiceSystems["claude-opus-high-voice"].transcription).toBe("gpt-4o-mini-transcribe")
    expect(voiceSystems["claude-opus-max-voice"].transcription).toBe("gpt-4o-mini-transcribe")
  })

  test("VoiceSystemName type covers all keys", () => {
    const names: VoiceSystemName[] = [
      "claude-opus-medium-voice",
      "claude-opus-high-voice",
      "claude-opus-max-voice",
      "gpt-medium-voice",
      "gpt-high-voice",
      "gpt-xhigh-voice",
      "gpt-audio-voice",
      "gemini-flash-voice",
      "gemini-pro-voice",
      "minimax-m2-voice",
    ]
    expect(names.length).toBe(Object.keys(voiceSystems).length)
  })

  test("VoiceSystem type is usable for custom systems", () => {
    const custom: VoiceSystem = {
      model: "custom/my-model",
      variant: "fast",
      transcription: "whisper-1",
      tts: { model: "tts-1", voice: "alloy", speed: 1.0 },
      agent: "voice-plan",
      apiKey: "key",
      baseUrl: "https://custom.com/v1",
    }
    expect(custom.model).toBe("custom/my-model")
    expect(custom.agent).toBe("voice-plan")
  })
})
