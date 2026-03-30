import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import DESCRIPTION from "./read_audio.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Filesystem } from "../util/filesystem"

const MAX_SIZE = 25 * 1024 * 1024

export const ReadAudioTool = Tool.define("read_audio", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the audio file to read"),
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

    const mime = Filesystem.mimeType(filepath)
    if (!mime.startsWith("audio/")) throw new Error(`Not an audio file: ${filepath} (detected type: ${mime})`)

    const msg = "Audio file read successfully"
    return {
      title,
      output: msg,
      metadata: { preview: msg, truncated: false },
      attachments: [
        {
          type: "file",
          mime,
          url: `data:${mime};base64,${Buffer.from(await Filesystem.readBytes(filepath)).toString("base64")}`,
        },
      ],
    }
  },
})
