import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { ReadAudioTool } from "../../src/tool/read_audio"
import { SessionID, MessageID } from "../../src/session/schema"

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

describe("tool.read_audio", () => {
  test("reads wav and returns attachment", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.wav"), new Uint8Array([1, 2, 3, 4]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "test.wav") }, ctx)
        expect(result.output).toBe("Audio file read successfully")
        expect(result.attachments).toBeDefined()
        expect(result.attachments?.length).toBe(1)
        expect(result.attachments?.[0].type).toBe("file")
        expect(result.attachments?.[0].mime).toBe("audio/wav")
        expect(result.attachments?.[0].url).toStartWith("data:audio/wav;base64,")
      },
    })
  })

  test("attachment decodes to original bytes", async () => {
    const data = new Uint8Array([10, 20, 30, 40, 50])
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.wav"), data)
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "test.wav") }, ctx)
        const url = result.attachments![0].url
        const b64 = url.slice(url.indexOf(",") + 1)
        const decoded = new Uint8Array(Buffer.from(b64, "base64"))
        expect(decoded).toEqual(data)
      },
    })
  })

  test("reads mp3 with correct mime", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.mp3"), new Uint8Array([1]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "test.mp3") }, ctx)
        expect(result.attachments?.[0].mime).toBe("audio/mpeg")
      },
    })
  })

  test("reads flac with correct mime", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.flac"), new Uint8Array([1]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "test.flac") }, ctx)
        expect(result.attachments?.[0].mime).toBe("audio/x-flac")
      },
    })
  })

  test("metadata has truncated false and preview", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.wav"), new Uint8Array([1]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "test.wav") }, ctx)
        expect(result.metadata.truncated).toBe(false)
        expect(result.metadata.preview).toBe("Audio file read successfully")
      },
    })
  })

  test("attachments do not include id, sessionID, or messageID", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.wav"), new Uint8Array([1]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "test.wav") }, ctx)
        expect(result.attachments?.[0]).not.toHaveProperty("id")
        expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
        expect(result.attachments?.[0]).not.toHaveProperty("messageID")
      },
    })
  })

  test("throws for nonexistent file", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "missing.wav") }, ctx)).rejects.toThrow(
          "File not found",
        )
      },
    })
  })

  test("throws for non-audio file", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.txt"), "hello")
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        await expect(tool.execute({ filePath: path.join(tmp.path, "test.txt") }, ctx)).rejects.toThrow(
          "Not an audio file",
        )
      },
    })
  })

  test("non-audio error includes detected type", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "test.png"), new Uint8Array([1]))
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tool = await ReadAudioTool.init()
        try {
          await tool.execute({ filePath: path.join(tmp.path, "test.png") }, ctx)
          expect.unreachable("should have thrown")
        } catch (err: any) {
          expect(err.message).toContain("detected type: image/png")
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
        const tool = await ReadAudioTool.init()
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
        const tool = await ReadAudioTool.init()
        try {
          await tool.execute({ filePath: path.join(tmp.path, "big.wav") }, ctx)
          expect.unreachable("should have thrown")
        } catch (err: any) {
          expect(err.message).toContain("max 25MB")
        }
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
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: path.join(tmp.path, "sub", "audio.wav") }, ctx)
        expect(result.title).toContain(path.join("sub", "audio.wav"))
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
        const tool = await ReadAudioTool.init()
        const result = await tool.execute({ filePath: "rel.wav" }, ctx)
        expect(result.output).toBe("Audio file read successfully")
        expect(result.attachments?.length).toBe(1)
      },
    })
  })
})
