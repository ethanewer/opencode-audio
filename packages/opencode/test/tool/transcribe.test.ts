import { afterEach, describe, expect, mock, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"

mock.module("ai", () => ({
  experimental_transcribe: async (opts: { model: { modelId: string }; audio: Uint8Array }) => {
    return { text: `transcribed ${opts.audio.length} bytes` }
  },
}))

const { TranscribeTool } = await import("../../src/tool/transcribe")

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

describe("tool.transcribe", () => {
  test.each([".flac", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg", ".wav", ".webm"])(
    "accepts %s format",
    async (ext) => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, `test${ext}`), new Uint8Array([1, 2, 3]))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const tool = await TranscribeTool.init()
          const result = await tool.execute({ filePath: path.join(tmp.path, `test${ext}`) }, ctx)
          expect(result.output).toBe("transcribed 3 bytes")
        },
      })
    },
  )

  test("sets truncated to false", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.wav"), new Uint8Array([1, 2]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TranscribeTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "test.wav") }, ctx)
        expect(result.metadata.truncated).toBe(false)
      },
    })
  })

  test("title is relative path", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "sub", "audio.wav"), new Uint8Array([1]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TranscribeTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "sub", "audio.wav") }, ctx)
        expect(result.title).toContain(path.join("sub", "audio.wav"))
      },
    })
  })

  test("throws for nonexistent file", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TranscribeTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "missing.wav") }, ctx)).rejects.toThrow(
          "File not found",
        )
      },
    })
  })

  test.each([".aiff", ".wma", ".aac", ".txt", ".png"])("rejects %s format", async (ext) => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, `test${ext}`), new Uint8Array([1]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TranscribeTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, `test${ext}`) }, ctx)).rejects.toThrow(
          `Unsupported audio format: ${ext}`,
        )
      },
    })
  })

  test("unsupported format error lists supported formats", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.aiff"), new Uint8Array([1]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TranscribeTool.init()
        try {
          await tool.execute({ filePath: path.join(tmp.path, "test.aiff") }, ctx)
          expect.unreachable("should have thrown")
        } catch (err: any) {
          expect(err.message).toContain("Supported formats:")
          expect(err.message).toContain("wav")
          expect(err.message).toContain("mp3")
        }
      },
    })
  })

  test("throws for oversized file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "big.wav"), new Uint8Array(25 * 1024 * 1024 + 1))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TranscribeTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "big.wav") }, ctx)).rejects.toThrow(
          "Audio file too large",
        )
      },
    })
  })

  test("oversized error includes max size", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "big.wav"), new Uint8Array(26 * 1024 * 1024))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TranscribeTool.init()
        try {
          await tool.execute({ filePath: path.join(tmp.path, "big.wav") }, ctx)
          expect.unreachable("should have thrown")
        } catch (err: any) {
          expect(err.message).toContain("max 25MB")
        }
      },
    })
  })

  test("resolves relative path against instance directory", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "rel.wav"), new Uint8Array([1, 2]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await TranscribeTool.init()
        const result = await tool.execute({ filePath: "rel.wav" }, ctx)
        expect(result.output).toBe("transcribed 2 bytes")
      },
    })
  })
})
