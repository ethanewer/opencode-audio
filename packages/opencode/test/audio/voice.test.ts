import { describe, test, expect, beforeEach, mock } from "bun:test"
import {
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

// ---------------------------------------------------------------------------
// createVoiceSession — integration tests with mock client
// ---------------------------------------------------------------------------

describe("createVoiceSession", () => {
  const original = globalThis.fetch

  // Helper to create an SSE async generator that we control
  function createMockEventStream() {
    const events: any[] = []
    let resolve: (() => void) | null = null
    let done = false

    const generator = async function* () {
      while (!done) {
        while (events.length > 0) {
          yield events.shift()
        }
        if (done) return
        await new Promise<void>((r) => {
          resolve = r
        })
      }
    }

    return {
      stream: generator(),
      push(event: any) {
        events.push(event)
        if (resolve) {
          const r = resolve
          resolve = null
          r()
        }
      },
      end() {
        done = true
        if (resolve) {
          const r = resolve
          resolve = null
          r()
        }
      },
    }
  }

  function createMockClient(sse: ReturnType<typeof createMockEventStream>) {
    const calls: Record<string, any[]> = {
      create: [],
      prompt: [],
      promptAsync: [],
      abort: [],
      reply: [],
    }

    return {
      calls,
      client: {
        session: {
          create: mock(async (params: any) => {
            calls.create.push(params)
            return { data: { id: "ses_test123" }, error: undefined }
          }),
          prompt: mock(async (params: any) => {
            calls.prompt.push(params)
            return { data: { info: {}, parts: [] }, error: undefined }
          }),
          promptAsync: mock(async (params: any) => {
            calls.promptAsync.push(params)
            return { data: undefined, error: undefined }
          }),
          abort: mock(async (params: any) => {
            calls.abort.push(params)
            return { data: undefined, error: undefined }
          }),
        },
        event: {
          subscribe: mock(async () => ({ stream: sse.stream })),
        },
        permission: {
          reply: mock(async (params: any) => {
            calls.reply.push(params)
            return { data: true, error: undefined }
          }),
        },
      } as any,
    }
  }

  beforeEach(() => {
    // Mock fetch for TTS/STT calls inside createVoiceSession
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      const url = req.url

      if (url.includes("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "transcribed text" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }

      if (url.includes("/audio/speech")) {
        return new Response(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), {
          status: 200,
        })
      }

      return new Response("not found", { status: 404 })
    }) as any
  })

  afterEach(() => {
    globalThis.fetch = original
  })

  test("creates session and returns voice session object", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    expect(session.sessionID).toBe("ses_test123")
    expect(session.input).toBeInstanceOf(AsyncAudioQueue)
    expect(session.output).toBeInstanceOf(AsyncAudioQueue)
    expect(typeof session.abort).toBe("function")
    expect(typeof session.close).toBe("function")
    expect(calls.create.length).toBe(1)

    session.close()
    sse.end()
  })

  test("reuses existing session ID when provided", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
      sessionID: "ses_existing",
    })

    expect(session.sessionID).toBe("ses_existing")
    expect(calls.create.length).toBe(0)

    session.close()
    sse.end()
  })

  test("dangerous mode passes allow-all permission ruleset", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
      permission: "dangerous",
    })

    expect(calls.create[0].permission).toEqual([{ permission: "*", pattern: "*", action: "allow" }])

    session.close()
    sse.end()
  })

  test("safe mode passes no extra permission rules", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
      permission: "safe",
    })

    expect(calls.create[0].permission).toBeUndefined()

    session.close()
    sse.end()
  })

  test("input audio is transcribed and sent as prompt", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1, 2, 3]))
    // Close input to let the input loop finish
    session.input.close()

    // Wait for the input loop to process
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt.length).toBe(1)
    expect(calls.prompt[0].sessionID).toBe("ses_test123")
    expect(calls.prompt[0].parts[0].type).toBe("text")
    expect(calls.prompt[0].parts[0].text).toBe("transcribed text")
    expect(calls.prompt[0].agent).toBe("voice-build")
    expect(calls.prompt[0].model).toEqual({ providerID: "test", modelID: "model" })

    session.close()
    sse.end()
  })

  test("custom agent is passed to prompt", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "test/model", agent: "voice-plan", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].agent).toBe("voice-plan")

    session.close()
    sse.end()
  })

  test("message.part.delta events produce TTS audio on output queue", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      sessionID: "ses_delta",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    // Push enough text as deltas to trigger sentence splitting (>= 40 chars)
    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_delta",
        messageID: "msg1",
        partID: "part1",
        field: "text",
        delta: "This is a sentence that is long enough to trigger TTS. ",
      },
    })

    // Wait for the async pipeline to process
    await new Promise((r) => setTimeout(r, 200))

    const result = await session.output.next()
    expect(result.done).toBe(false)
    expect(result.value).toBeInstanceOf(Uint8Array)
    expect(result.value.length).toBeGreaterThan(0)

    session.close()
    sse.end()
  })

  test("session idle flushes remaining text buffer", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      sessionID: "ses_flush",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    // Push short text that won't trigger sentence splitting
    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_flush",
        messageID: "msg1",
        partID: "part1",
        field: "text",
        delta: "Short text",
      },
    })

    await new Promise((r) => setTimeout(r, 50))

    // Now send idle to flush
    sse.push({
      type: "session.status",
      properties: {
        sessionID: "ses_flush",
        status: { type: "idle" },
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    const result = await session.output.next()
    expect(result.done).toBe(false)
    expect(result.value).toBeInstanceOf(Uint8Array)

    session.close()
    sse.end()
  })

  test("ignores events from other sessions", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    let ttsCalled = false
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        ttsCalled = true
        return new Response(new Uint8Array([0]), { status: 200 })
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_mine",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_other",
        messageID: "msg1",
        partID: "part1",
        field: "text",
        delta: "This sentence is from another session and should be ignored by this one. ",
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    // TTS should never have been called since the event was for a different session
    expect(ttsCalled).toBe(false)

    session.close()
    sse.end()
  })

  test("ignores non-text field deltas", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    let ttsCalled = false
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        ttsCalled = true
        return new Response(new Uint8Array([0]), { status: 200 })
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_field",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_field",
        messageID: "msg1",
        partID: "part1",
        field: "reasoning",
        delta: "This is reasoning content that should not trigger TTS at all. ",
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    // TTS should never have been called since the delta was for a non-text field
    expect(ttsCalled).toBe(false)

    session.close()
    sse.end()
  })

  test("safe mode auto-rejects permission requests", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      sessionID: "ses_perm",
      permission: "safe",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    sse.push({
      type: "permission.asked",
      properties: {
        id: "perm_123",
        sessionID: "ses_perm",
        permission: "bash",
        patterns: ["rm -rf /"],
        metadata: {},
        always: [],
      },
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(calls.reply.length).toBe(1)
    expect(calls.reply[0].requestID).toBe("perm_123")
    expect(calls.reply[0].reply).toBe("reject")

    session.close()
    sse.end()
  })

  test("safe mode ignores permission requests from other sessions", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      sessionID: "ses_perm2",
      permission: "safe",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    sse.push({
      type: "permission.asked",
      properties: {
        id: "perm_456",
        sessionID: "ses_other",
        permission: "bash",
        patterns: ["ls"],
        metadata: {},
        always: [],
      },
    })

    await new Promise((r) => setTimeout(r, 100))

    expect(calls.reply.length).toBe(0)

    session.close()
    sse.end()
  })

  test("dangerous mode does not auto-reject permissions", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      sessionID: "ses_danger",
      permission: "dangerous",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    sse.push({
      type: "permission.asked",
      properties: {
        id: "perm_789",
        sessionID: "ses_danger",
        permission: "bash",
        patterns: ["rm -rf /"],
        metadata: {},
        always: [],
      },
    })

    await new Promise((r) => setTimeout(r, 100))

    // No reply should have been made — in dangerous mode, the allow-all ruleset
    // prevents permission events from being emitted, but even if one arrives,
    // the handler doesn't reject it
    expect(calls.reply.length).toBe(0)

    session.close()
    sse.end()
  })

  test("done promise resolves after close", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      sessionID: "ses_done",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    expect(session.done).toBeInstanceOf(Promise)

    session.close()
    sse.end()

    // done should resolve after background loops exit
    const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 2000))
    const result = await Promise.race([session.done.then(() => "resolved" as const), timeout])
    expect(result).toBe("resolved")
  })

  test("close terminates both queues", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      sessionID: "ses_close",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.close()
    sse.end()

    expect(session.input.closed).toBe(true)
    expect(session.output.closed).toBe(true)
  })

  test("abort increments generation and calls session abort", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      sessionID: "ses_abort",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.abort()

    await new Promise((r) => setTimeout(r, 50))

    expect(calls.abort.length).toBe(1)
    expect(calls.abort[0].sessionID).toBe("ses_abort")

    session.close()
    sse.end()
  })

  test("model option is passed through to prompt", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "anthropic/claude-3", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].model).toEqual({ providerID: "anthropic", modelID: "claude-3" })

    session.close()
    sse.end()
  })

  test("empty transcription is skipped", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    // Mock STT to return empty string
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "   " }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as any

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    // No prompt should have been sent for empty transcription
    expect(calls.prompt.length).toBe(0)

    session.close()
    sse.end()
  })

  test("STT error does not crash the input loop", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    let count = 0
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/transcriptions")) {
        count++
        if (count === 1) {
          return new Response("error", { status: 500 })
        }
        return new Response(JSON.stringify({ text: "second attempt" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as any

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    // First input will fail STT
    session.input.push(new Uint8Array([1]))
    // Second input will succeed
    session.input.push(new Uint8Array([2]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 200))

    // Only the second input should have produced a prompt
    expect(calls.prompt.length).toBe(1)
    expect(calls.prompt[0].parts[0].text).toBe("second attempt")

    session.close()
    sse.end()
  })

  test("TTS error does not crash the output loop", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    let ttsCount = 0
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        ttsCount++
        if (ttsCount === 1) {
          return new Response("error", { status: 500 })
        }
        return new Response(new Uint8Array([0xca, 0xfe]), { status: 200 })
      }
      if (req.url.includes("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "ok" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response("not found", { status: 404 })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_tts_err",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    // First sentence will fail TTS
    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_tts_err",
        messageID: "msg1",
        partID: "part1",
        field: "text",
        delta: "First sentence that will fail during text to speech conversion. ",
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    // Reset messageID tracking for next message by sending idle then new delta
    sse.push({
      type: "session.status",
      properties: { sessionID: "ses_tts_err", status: { type: "idle" } },
    })

    await new Promise((r) => setTimeout(r, 50))

    // Second sentence should succeed (new message)
    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_tts_err",
        messageID: "msg2",
        partID: "part2",
        field: "text",
        delta: "Second sentence that should succeed and produce some audio output. ",
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    const result = await session.output.next()
    expect(result.done).toBe(false)
    expect(result.value).toBeInstanceOf(Uint8Array)

    session.close()
    sse.end()
  })

  test("tools option is passed through to prompt", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      tools: { bash: true, edit: false, read: true },
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].tools).toEqual({ bash: true, edit: false, read: true })

    session.close()
    sse.end()
  })

  test("system prompt is passed through to prompt", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
      prompt: "You are a helpful coding assistant. Always respond concisely.",
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].system).toBe("You are a helpful coding assistant. Always respond concisely.")

    session.close()
    sse.end()
  })

  test("format option is passed through to prompt", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const format = { type: "text" as const }
    const session = await createVoiceSession(client, {
      format,
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].format).toEqual({ type: "text" })

    session.close()
    sse.end()
  })

  test("variant option is passed through to prompt", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "test/model", variant: "concise", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].variant).toBe("concise")

    session.close()
    sse.end()
  })

  test("noReply option is passed through to prompt", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      noReply: true,
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].noReply).toBe(true)

    session.close()
    sse.end()
  })

  test("noReply false is passed through explicitly", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      noReply: false,
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].noReply).toBe(false)

    session.close()
    sse.end()
  })

  test("title and parentID are passed to session.create", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      title: "My voice session",
      parentID: "ses_parent",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    expect(calls.create[0].title).toBe("My voice session")
    expect(calls.create[0].parentID).toBe("ses_parent")

    session.close()
    sse.end()
  })

  test("custom permission ruleset is passed to session.create", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const rules = [
      { permission: "bash", pattern: "*", action: "allow" as const },
      { permission: "edit", pattern: "*.ts", action: "allow" as const },
      { permission: "*", pattern: "*", action: "deny" as const },
    ]

    const session = await createVoiceSession(client, {
      permission: rules,
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    expect(calls.create[0].permission).toEqual(rules)

    session.close()
    sse.end()
  })

  test("custom permission ruleset still auto-rejects runtime prompts", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      sessionID: "ses_custom_perm",
      permission: [{ permission: "bash", pattern: "*", action: "allow" as const }],
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    sse.push({
      type: "permission.asked",
      properties: {
        id: "perm_custom",
        sessionID: "ses_custom_perm",
        permission: "edit",
        patterns: ["file.ts"],
        metadata: {},
        always: [],
      },
    })

    await new Promise((r) => setTimeout(r, 100))

    // Custom rulesets still auto-reject at runtime (not dangerous)
    expect(calls.reply.length).toBe(1)
    expect(calls.reply[0].reply).toBe("reject")

    session.close()
    sse.end()
  })

  test("all prompt options are sent together", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: {
        model: "openai/gpt-4o",
        agent: "voice-plan",
        variant: "short",
        apiKey: "key",
        baseUrl: "https://test.com/v1",
      },
      prompt: "Be concise",
      tools: { bash: false, read: true },
      format: { type: "text" },
      noReply: false,
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    const prompt = calls.prompt[0]
    expect(prompt.agent).toBe("voice-plan")
    expect(prompt.model).toEqual({ providerID: "openai", modelID: "gpt-4o" })
    expect(prompt.system).toBe("Be concise")
    expect(prompt.tools).toEqual({ bash: false, read: true })
    expect(prompt.format).toEqual({ type: "text" })
    expect(prompt.variant).toBe("short")
    expect(prompt.noReply).toBe(false)

    session.close()
    sse.end()
  })

  test("output receives streaming chunks not one drained buffer", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    // Mock TTS to return a multi-chunk stream
    let ttsCount = 0
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        ttsCount++
        const stream = new ReadableStream<Uint8Array>({
          start(ctrl) {
            ctrl.enqueue(new Uint8Array([0x01, 0x02]))
            ctrl.enqueue(new Uint8Array([0x03, 0x04]))
            ctrl.enqueue(new Uint8Array([0x05, 0x06]))
            ctrl.close()
          },
        })
        return new Response(stream, { status: 200 })
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_stream",
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_stream",
        messageID: "msg1",
        partID: "part1",
        field: "text",
        delta: "This is a sentence that is long enough to trigger text to speech. ",
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    // Should get 3 separate chunks, not 1 concatenated buffer
    const chunks: Uint8Array[] = []
    // Drain available items
    while (true) {
      const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 50))
      const next = session.output.next().then((r) => (r.done ? ("done" as const) : r.value))
      const result = await Promise.race([next, timeout])
      if (result === "timeout" || result === "done") break
      chunks.push(result)
    }

    expect(chunks.length).toBe(3)
    expect(chunks[0]).toEqual(new Uint8Array([0x01, 0x02]))
    expect(chunks[1]).toEqual(new Uint8Array([0x03, 0x04]))
    expect(chunks[2]).toEqual(new Uint8Array([0x05, 0x06]))

    session.close()
    sse.end()
  })

  test("minSentenceLength option reduces sentence threshold", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    let ttsCalled = false
    let ttsInput = ""
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        ttsCalled = true
        ttsInput = (await req.json()).input
        return new Response(new Uint8Array([0xaa]), { status: 200 })
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_minlen",
      minSentenceLength: 1,
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    // "Got it. " is only 7 chars — would be buffered with default 40,
    // but should be emitted immediately with minSentenceLength=1
    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_minlen",
        messageID: "msg1",
        partID: "part1",
        field: "text",
        delta: "Got it. ",
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    expect(ttsCalled).toBe(true)
    expect(ttsInput).toBe("Got it.")

    session.close()
    sse.end()
  })

  test("toolStatus option speaks tool execution status", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    const ttsInputs: string[] = []
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        ttsInputs.push((await req.json()).input)
        return new Response(new Uint8Array([0xbb]), { status: 200 })
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_tool",
      toolStatus: true,
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    // Simulate tool running
    sse.push({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_tool",
        part: {
          id: "p1",
          sessionID: "ses_tool",
          messageID: "msg1",
          type: "tool",
          callID: "call1",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "ls" },
            title: "listing files",
            time: { start: Date.now() },
          },
        },
        time: Date.now(),
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    // Simulate tool completed
    sse.push({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_tool",
        part: {
          id: "p1",
          sessionID: "ses_tool",
          messageID: "msg1",
          type: "tool",
          callID: "call1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "ls" },
            output: "file1.ts\nfile2.ts",
            title: "listing files",
            metadata: {},
            time: { start: Date.now() - 100, end: Date.now() },
          },
        },
        time: Date.now(),
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    expect(ttsInputs).toContain("Running listing files.")
    expect(ttsInputs).toContain("Completed listing files.")

    session.close()
    sse.end()
  })

  test("toolStatus false does not speak tool events", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    let ttsCalled = false
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        ttsCalled = true
        return new Response(new Uint8Array([0xbb]), { status: 200 })
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_notool",
      toolStatus: false,
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    sse.push({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_notool",
        part: {
          id: "p1",
          sessionID: "ses_notool",
          messageID: "msg1",
          type: "tool",
          callID: "call1",
          tool: "bash",
          state: {
            status: "running",
            input: { command: "ls" },
            title: "listing files",
            time: { start: Date.now() },
          },
        },
        time: Date.now(),
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    expect(ttsCalled).toBe(false)

    session.close()
    sse.end()
  })

  test("toolStatus speaks error state", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    const ttsInputs: string[] = []
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        ttsInputs.push((await req.json()).input)
        return new Response(new Uint8Array([0xcc]), { status: 200 })
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_toolerr",
      toolStatus: true,
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    sse.push({
      type: "message.part.updated",
      properties: {
        sessionID: "ses_toolerr",
        part: {
          id: "p1",
          sessionID: "ses_toolerr",
          messageID: "msg1",
          type: "tool",
          callID: "call1",
          tool: "edit",
          state: {
            status: "error",
            input: {},
            error: "file not found",
            time: { start: Date.now() - 50, end: Date.now() },
          },
        },
        time: Date.now(),
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    expect(ttsInputs).toContain("Error in edit.")

    session.close()
    sse.end()
  })

  test("stt audio is sent as-is in voice session", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    let blobSize = 0
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/transcriptions")) {
        const fd = await req.formData()
        const blob = fd.get("file") as Blob
        blobSize = blob.size
        return new Response(JSON.stringify({ text: "hello" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as any

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    // Push 4 bytes of audio
    session.input.push(new Uint8Array([0, 1, 2, 3]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 200))

    // Audio is sent as-is (no PCM format conversion without format option)
    expect(blobSize).toBe(4)

    session.close()
    sse.end()
  })

  test("tts speed option is passed through", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    let captured: { body: any } | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        captured = { body: await req.json() }
        return new Response(new Uint8Array([0xaa]), { status: 200 })
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const session = await createVoiceSession(client, {
      system: { model: "test/model", tts: { speed: 2.0 }, apiKey: "key", baseUrl: "https://test.com/v1" },
      sessionID: "ses_speed",
    })

    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_speed",
        messageID: "msg1",
        partID: "part1",
        field: "text",
        delta: "This is a sentence that is long enough to trigger text to speech. ",
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    expect(captured).toBeDefined()
    expect(captured!.body.speed).toBe(2.0)

    session.close()
    sse.end()
  })

  test("exported types are usable", () => {
    // Verify named types are importable and structurally correct
    const ttsOpts: TtsOptions = { model: "tts-1", voice: "alloy", speed: 1.5 }
    expect(ttsOpts.speed).toBe(1.5)

    const sttOpts: SttOptions = { model: "whisper-1", signal: new AbortController().signal }
    expect(sttOpts.signal).toBeDefined()

    const fmt: PcmFormat = { sampleRate: 24000, channels: 1, bitDepth: 16 }
    expect(fmt.sampleRate).toBe(24000)
  })

  test("omitted prompt options are not sent", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    const prompt = calls.prompt[0]
    expect(prompt.system).toBeUndefined()
    expect(prompt.tools).toBeUndefined()
    expect(prompt.format).toBeUndefined()
    expect(prompt.variant).toBeUndefined()
    expect(prompt.noReply).toBeUndefined()

    session.close()
    sse.end()
  })

  test("multiple sequential inputs are processed in order", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    let seq = 0
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/transcriptions")) {
        seq++
        return new Response(JSON.stringify({ text: `message ${seq}` }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as any

    const session = await createVoiceSession(client, {
      system: { model: "test/model", apiKey: "key", baseUrl: "https://test.com/v1" },
    })

    session.input.push(new Uint8Array([1]))
    session.input.push(new Uint8Array([2]))
    session.input.push(new Uint8Array([3]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 300))

    expect(calls.prompt.length).toBe(3)
    expect(calls.prompt[0].parts[0].text).toBe("message 1")
    expect(calls.prompt[1].parts[0].text).toBe("message 2")
    expect(calls.prompt[2].parts[0].text).toBe("message 3")

    session.close()
    sse.end()
  })

  test("built-in system name resolves to correct config", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    // Use a custom system mirroring claude-opus-medium-voice but with test credentials
    const session = await createVoiceSession(client, {
      system: {
        ...voiceSystems["claude-opus-medium-voice"],
        apiKey: "key",
        baseUrl: "https://test.com/v1",
      },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].model).toEqual({ providerID: "anthropic", modelID: "claude-opus-4-6" })
    expect(calls.prompt[0].variant).toBe("medium")
    expect(calls.prompt[0].agent).toBe("voice-build")

    session.close()
    sse.end()
  })

  test("built-in system with variant passes variant to prompt", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: {
        ...voiceSystems["gpt-xhigh-voice"],
        apiKey: "key",
        baseUrl: "https://test.com/v1",
      },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].model).toEqual({ providerID: "openai", modelID: "gpt-5.4" })
    expect(calls.prompt[0].variant).toBe("xhigh")

    session.close()
    sse.end()
  })

  test("system without TTS still resolves STT and model", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: {
        model: "provider/model-no-tts",
        transcription: "whisper-1",
        apiKey: "key",
        baseUrl: "https://test.com/v1",
      },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].model).toEqual({ providerID: "provider", modelID: "model-no-tts" })

    session.close()
    sse.end()
  })

  test("system TTS config is passed to speech endpoint", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    let captured: { body: any } | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/speech")) {
        captured = { body: await req.json() }
        return new Response(new Uint8Array([0xaa]), { status: 200 })
      }
      return new Response(JSON.stringify({ text: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_tts_cfg",
      system: {
        model: "test/model",
        tts: { model: "custom-tts", voice: "nova", speed: 1.5 },
        apiKey: "key",
        baseUrl: "https://test.com/v1",
      },
    })

    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_tts_cfg",
        messageID: "msg1",
        partID: "part1",
        field: "text",
        delta: "This is a sentence that is long enough to trigger text to speech. ",
      },
    })

    await new Promise((r) => setTimeout(r, 200))

    expect(captured).toBeDefined()
    expect(captured!.body.model).toBe("custom-tts")
    expect(captured!.body.voice).toBe("nova")
    expect(captured!.body.speed).toBe(1.5)

    session.close()
    sse.end()
  })

  test("system STT model is passed to transcription endpoint", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    let sttModel: string | undefined
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      if (req.url.includes("/audio/transcriptions")) {
        const fd = await req.formData()
        sttModel = fd.get("model") as string
        return new Response(JSON.stringify({ text: "hello" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      return new Response(new Uint8Array([0]), { status: 200 })
    }) as any

    const session = await createVoiceSession(client, {
      system: {
        model: "test/model",
        transcription: "custom-stt-model",
        apiKey: "key",
        baseUrl: "https://test.com/v1",
      },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(sttModel).toBe("custom-stt-model")

    session.close()
    sse.end()
  })

  test("system without apiKey/baseUrl does not configure STT opts when no transcription", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    // System with no transcription, no apiKey, no baseUrl — STT won't work but should not crash
    const session = await createVoiceSession(client, {
      system: { model: "test/model" },
    })

    expect(session.sessionID).toBe("ses_test123")

    session.close()
    sse.end()
  })

  test("system apiKey and baseUrl are used for both STT and TTS", async () => {
    const sse = createMockEventStream()
    const { client } = createMockClient(sse)

    const urls: string[] = []
    const keys: string[] = []
    globalThis.fetch = (async (input: any, init: any) => {
      const req = input instanceof Request ? input : new Request(input, init)
      urls.push(req.url)
      keys.push(req.headers.get("Authorization") ?? "")
      if (req.url.includes("/audio/transcriptions")) {
        return new Response(JSON.stringify({ text: "hello" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      if (req.url.includes("/audio/speech")) {
        return new Response(new Uint8Array([0xaa]), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }) as any

    const session = await createVoiceSession(client, {
      sessionID: "ses_keys",
      system: {
        model: "test/model",
        transcription: "stt-model",
        tts: { model: "tts-model" },
        apiKey: "my-api-key",
        baseUrl: "https://custom.api.com/v1",
      },
    })

    // Trigger STT
    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    // Trigger TTS
    sse.push({
      type: "message.part.delta",
      properties: {
        sessionID: "ses_keys",
        messageID: "msg1",
        partID: "part1",
        field: "text",
        delta: "This is a sentence that is long enough to trigger text to speech. ",
      },
    })
    await new Promise((r) => setTimeout(r, 200))

    // Both STT and TTS should use the custom base URL and API key
    expect(urls.some((u) => u.startsWith("https://custom.api.com/v1/audio/transcriptions"))).toBe(true)
    expect(urls.some((u) => u.startsWith("https://custom.api.com/v1/audio/speech"))).toBe(true)
    expect(keys.every((k) => k === "Bearer my-api-key")).toBe(true)

    session.close()
    sse.end()
  })

  test("model with slashes in modelID is parsed correctly", async () => {
    const sse = createMockEventStream()
    const { client, calls } = createMockClient(sse)

    const session = await createVoiceSession(client, {
      system: {
        model: "openrouter/google/gemini-3.1-flash-lite-preview",
        apiKey: "key",
        baseUrl: "https://test.com/v1",
      },
    })

    session.input.push(new Uint8Array([1]))
    session.input.close()
    await new Promise((r) => setTimeout(r, 100))

    expect(calls.prompt[0].model).toEqual({
      providerID: "openrouter",
      modelID: "google/gemini-3.1-flash-lite-preview",
    })

    session.close()
    sse.end()
  })
})

// ---------------------------------------------------------------------------
// voiceSystems — built-in system presets
// ---------------------------------------------------------------------------

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

// Need afterEach at module scope for the createVoiceSession describe block
import { afterEach } from "bun:test"
