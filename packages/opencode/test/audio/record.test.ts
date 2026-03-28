import { describe, test, expect } from "bun:test"
import { cmd, record } from "../../src/audio/record"

describe("audio.record", () => {
  test("cmd returns rec args when rec is available", () => {
    const args = cmd()
    expect(args[0]).toBeOneOf(["rec", "ffmpeg"])
    if (args[0] === "rec") {
      expect(args).toContain("-t")
      expect(args).toContain("wav")
    }
    if (args[0] === "ffmpeg") {
      expect(args).toContain("-f")
      expect(args).toContain("wav")
      expect(args).toContain("pipe:1")
    }
  })

  test("cmd output format is always wav", () => {
    const args = cmd()
    expect(args).toContain("wav")
  })

  test("ffmpeg uses avfoundation on darwin, pulse on linux", () => {
    const args = cmd()
    if (args[0] !== "ffmpeg") return
    if (process.platform === "darwin") {
      expect(args).toContain("avfoundation")
    } else {
      expect(args).toContain("pulse")
    }
  })

  test("record returns object with stop method", () => {
    const rec = record()
    expect(rec).toBeDefined()
    expect(typeof rec.stop).toBe("function")
    rec.stop()
  })

  test("stop returns Uint8Array", async () => {
    const rec = record()
    const audio = await rec.stop()
    expect(audio).toBeInstanceOf(Uint8Array)
  })
})
