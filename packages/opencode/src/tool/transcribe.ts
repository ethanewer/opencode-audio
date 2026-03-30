import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./transcribe.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Filesystem } from "../util/filesystem"
import { transcribe } from "../audio/transcribe"
import { Config } from "../config/config"

const MAX_SIZE = 25 * 1024 * 1024

const SUPPORTED = new Set([".flac", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg", ".wav", ".webm"])

export const TranscribeTool = Tool.define("transcribe", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the audio file to transcribe"),
  }),
  async execute(params, ctx) {
    let filepath = params.filePath
    if (!path.isAbsolute(filepath)) filepath = path.resolve(Instance.directory, filepath)
    const title = path.relative(Instance.worktree, filepath)

    await assertExternalDirectory(ctx, filepath)
    await ctx.ask({
      permission: "read",
      patterns: [filepath],
      always: ["*"],
      metadata: {},
    })

    const stat = Filesystem.stat(filepath)
    if (!stat) throw new Error(`File not found: ${filepath}`)

    const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
    if (size > MAX_SIZE) throw new Error(`Audio file too large: ${(size / 1024 / 1024).toFixed(1)}MB (max 25MB)`)

    const ext = path.extname(filepath).toLowerCase()
    if (!SUPPORTED.has(ext))
      throw new Error(
        `Unsupported audio format: ${ext || "(no extension)"}. Supported formats: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.`,
      )

    const cfg = await Config.get()
    const text = await transcribe(
      new Uint8Array(await Bun.file(filepath).arrayBuffer()),
      cfg.experimental?.voice?.model,
      { abortSignal: ctx.abort },
    )

    return {
      title,
      output: text,
      metadata: { truncated: false },
    }
  },
})
