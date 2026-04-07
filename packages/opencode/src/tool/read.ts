import z from "zod"
import { createReadStream } from "fs"
import * as fs from "fs/promises"
import * as path from "path"
import { createInterface } from "readline"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Instruction } from "../session/instruction"
import { Filesystem } from "../util/filesystem"
import { Provider } from "../provider/provider"
import { generateText } from "ai"
import { ProviderTransform } from "../provider/transform"
import { transcribe as transcribeAudio } from "../audio/transcribe"
import { Config } from "../config/config"
import { Log } from "../util/log"
import type { Agent } from "../agent/agent"

const log = Log.create({ service: "read-tool" })

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_BYTES = 50 * 1024
const MAX_BYTES_LABEL = `${MAX_BYTES / 1024} KB`
const MAX_AUDIO_SIZE = 25 * 1024 * 1024
const MAX_RETRIES = 5

const AUDIO_EXTENSIONS = new Set([".flac", ".mp3", ".mp4", ".mpeg", ".mpga", ".m4a", ".ogg", ".wav", ".webm"])

const ReadParams = z.object({
  filePath: z.string().describe("The absolute path to the file or directory to read"),
  offset: z.coerce.number().describe("The line number to start reading from (1-indexed)").optional(),
  limit: z.coerce.number().describe("The maximum number of lines to read (defaults to 2000)").optional(),
})

type ReadMeta = {
  preview?: string
  truncated: boolean
  loaded: string[]
}

type VisionMode = "none" | "aux" | "native"
type AudioMode = "none" | "aux" | "native"

const VISION_DESC: Record<VisionMode, string> = {
  none: "",
  aux: "- For image files (PNG, JPG, GIF, WEBP): the image is analyzed by a vision model and a text description is returned.",
  native: "- For image files (PNG, JPG, GIF, WEBP): the file content is returned as a native attachment for direct visual analysis.",
}

const PDF_DESC = "- For PDF files: the content is returned as a native attachment for direct analysis."

const AUDIO_DESC: Record<AudioMode, string> = {
  none: "",
  aux: "- For audio files (flac, mp3, mp4, m4a, ogg, wav, webm): the audio is transcribed and returned as text. Max 25MB.",
  native: "- For audio files (flac, mp3, mp4, m4a, ogg, wav, webm): the audio content is returned as a native attachment. Max 25MB.",
}

const SEARCH_HINTS = [
  "- Use the grep tool to find specific content in large files or files with long lines.",
  "- If you are unsure of the correct file path, use the glob tool to look up filenames by glob pattern.",
].join("\n")

function describe(vision: VisionMode, audio: AudioMode, pdf: boolean, search: boolean) {
  const parts = [DESCRIPTION]
  if (search) parts.push(SEARCH_HINTS)
  if (VISION_DESC[vision]) parts.push(VISION_DESC[vision])
  if (pdf) parts.push(PDF_DESC)
  if (AUDIO_DESC[audio]) parts.push(AUDIO_DESC[audio])
  return parts.join("\n")
}

function isKira(agent?: Agent.Info) {
  return agent?.name === "build" || agent?.name === "voice-build"
}

export const ReadTool = Tool.define<typeof ReadParams, ReadMeta>("read", async (initCtx) => {
  const caps = initCtx?.capabilities
  const vision: VisionMode = caps?.imageInput ? "native" : caps?.hasVisionModel ? "aux" : "none"
  const audio: AudioMode = caps?.audioInput ? "native" : caps?.hasTranscription ? "aux" : "none"
  const pdf = caps?.pdfInput === true
  const search = !isKira(initCtx?.agent)

  return {
    description: describe(vision, audio, pdf, search),
    parameters: ReadParams,
    async execute(params, ctx) {
      if (params.offset !== undefined && params.offset < 1) {
        throw new Error("offset must be greater than or equal to 1")
      }
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(Instance.directory, filepath)
      }
      if (process.platform === "win32") {
        filepath = Filesystem.normalizePath(filepath)
      }
      const title = path.relative(Instance.worktree, filepath)

      const stat = Filesystem.stat(filepath)

      await assertExternalDirectory(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: stat?.isDirectory() ? "directory" : "file",
      })

      await ctx.ask({
        permission: "read",
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })

      if (!stat) {
        const dir = path.dirname(filepath)
        const base = path.basename(filepath)

        const suggestions = await fs
          .readdir(dir)
          .then((entries) =>
            entries
              .filter(
                (entry) =>
                  entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
              )
              .map((entry) => path.join(dir, entry))
              .slice(0, 3),
          )
          .catch(() => [])

        if (suggestions.length > 0) {
          throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
        }

        throw new Error(`File not found: ${filepath}`)
      }

      if (stat.isDirectory()) {
        const dirents = await fs.readdir(filepath, { withFileTypes: true })
        const entries = await Promise.all(
          dirents.map(async (dirent) => {
            if (dirent.isDirectory()) return dirent.name + "/"
            if (dirent.isSymbolicLink()) {
              const target = await fs.stat(path.join(filepath, dirent.name)).catch(() => undefined)
              if (target?.isDirectory()) return dirent.name + "/"
            }
            return dirent.name
          }),
        )
        entries.sort((a, b) => a.localeCompare(b))

        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset ?? 1
        const start = offset - 1
        const sliced = entries.slice(start, start + limit)
        const truncated = start + sliced.length < entries.length

        const output = [
          `<path>${filepath}</path>`,
          `<type>directory</type>`,
          `<entries>`,
          sliced.join("\n"),
          truncated
            ? `\n(Showing ${sliced.length} of ${entries.length} entries. Use 'offset' parameter to read beyond entry ${offset + sliced.length})`
            : `\n(${entries.length} entries)`,
          `</entries>`,
        ].join("\n")

        return {
          title,
          output,
          metadata: {
            preview: sliced.slice(0, 20).join("\n"),
            truncated,
            loaded: [] as string[],
          },
        }
      }

      const instructions = await Instruction.resolve(ctx.messages, filepath, ctx.messageID)

      const mime = Filesystem.mimeType(filepath)

      if (mime.startsWith("audio/")) {
        if (audio === "none") throw new Error(`Cannot read audio file: ${filepath}`)
        const size = typeof stat.size === "bigint" ? Number(stat.size) : stat.size
        if (size > MAX_AUDIO_SIZE)
          throw new Error(`Audio file too large: ${(size / 1024 / 1024).toFixed(1)}MB (max 25MB)`)

        if (audio === "native") {
          const msg = "Audio file read successfully"
          return {
            title,
            output: msg,
            metadata: { preview: msg, truncated: false, loaded: instructions.map((i) => i.filepath) },
            attachments: [
              {
                type: "file",
                mime,
                url: `data:${mime};base64,${Buffer.from(await Filesystem.readBytes(filepath)).toString("base64")}`,
              },
            ],
          }
        }

        const ext = path.extname(filepath).toLowerCase()
        if (!AUDIO_EXTENSIONS.has(ext))
          throw new Error(
            `Unsupported audio format: ${ext || "(no extension)"}. Supported: flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm.`,
          )
        const cfg = await Config.get()
        const text = await transcribeAudio(
          new Uint8Array(await Bun.file(filepath).arrayBuffer()),
          cfg.experimental?.voice?.model,
          { abortSignal: ctx.abort },
        )
        return {
          title,
          output: text,
          metadata: { preview: text.slice(0, 200), truncated: false, loaded: instructions.map((i) => i.filepath) },
        }
      }

      // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
      const isImage = mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet"
      const isPdf = mime === "application/pdf"
      if (isPdf && !pdf) throw new Error(`Cannot read PDF file: model does not support PDF input`)
      if (isImage || isPdf) {
        if ((isPdf && pdf) || vision === "native") {
          const msg = `${isImage ? "Image" : "PDF"} read successfully`
          return {
            title,
            output: msg,
            metadata: {
              preview: msg,
              truncated: false,
              loaded: instructions.map((i) => i.filepath),
            },
            attachments: [
              {
                type: "file",
                mime,
                url: `data:${mime};base64,${Buffer.from(await Filesystem.readBytes(filepath)).toString("base64")}`,
              },
            ],
          }
        }
        if (isImage && vision === "aux") {
          const target = (ctx.extra?.visionModel ?? ctx.extra?.model) as Provider.Model | undefined
          if (!target) throw new Error(`Cannot read image: no vision-capable model available for ${filepath}`)
          const buf = await Bun.file(filepath).arrayBuffer()
          const url = `data:${mime};base64,${Buffer.from(buf).toString("base64")}`
          const language = await Provider.getLanguage(target)
          const providerOptions: Record<string, any> = {}
          if (target.api?.npm === "@openrouter/ai-sdk-provider") {
            providerOptions.openrouter = { reasoning: { effort: "high" } }
          }
          const result = await retry(() =>
            generateText({
              model: language,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: "Analyze this image carefully and thoroughly. Describe every visual element, spatial relationship, text, symbol, and structural detail you can identify. Be precise about positions, labels, and values.",
                    },
                    { type: "image", image: url },
                  ],
                },
              ],
              maxOutputTokens: ProviderTransform.maxOutputTokens(target),
              providerOptions,
            }),
          )
          const output = `Image description for '${filepath}':\n${result.text}`
          return {
            title,
            output,
            metadata: {
              preview: output.slice(0, 200),
              truncated: false,
              loaded: instructions.map((i) => i.filepath),
            },
          }
        }
        if (isImage) throw new Error(`Cannot read image: no vision-capable model available for ${filepath}`)
      }

      const isBinary = await isBinaryFile(filepath, Number(stat.size))
      if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

      const stream = createReadStream(filepath, { encoding: "utf8" })
      const rl = createInterface({
        input: stream,
        crlfDelay: Infinity,
      })

      const limit = params.limit ?? DEFAULT_READ_LIMIT
      const offset = params.offset ?? 1
      const start = offset - 1
      const raw: string[] = []
      let bytes = 0
      let lines = 0
      let truncatedByBytes = false
      let hasMoreLines = false
      try {
        for await (const text of rl) {
          lines += 1
          if (lines <= start) continue

          if (raw.length >= limit) {
            hasMoreLines = true
            continue
          }

          const line = text.length > MAX_LINE_LENGTH ? text.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : text
          const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
          if (bytes + size > MAX_BYTES) {
            truncatedByBytes = true
            hasMoreLines = true
            break
          }

          raw.push(line)
          bytes += size
        }
      } finally {
        rl.close()
        stream.destroy()
      }

      if (lines < offset && !(lines === 0 && offset === 1)) {
        throw new Error(`Offset ${offset} is out of range for this file (${lines} lines)`)
      }

      const content = raw.map((line, index) => {
        return `${index + offset}: ${line}`
      })
      const preview = raw.slice(0, 20).join("\n")

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>"].join("\n")
      output += content.join("\n")

      const totalLines = lines
      const lastReadLine = offset + raw.length - 1
      const nextOffset = lastReadLine + 1
      const truncated = hasMoreLines || truncatedByBytes

      if (truncatedByBytes) {
        output += `\n\n(Output capped at ${MAX_BYTES_LABEL}. Showing lines ${offset}-${lastReadLine}. Use offset=${nextOffset} to continue.)`
      } else if (hasMoreLines) {
        output += `\n\n(Showing lines ${offset}-${lastReadLine} of ${totalLines}. Use offset=${nextOffset} to continue.)`
      } else {
        output += `\n\n(End of file - total ${totalLines} lines)`
      }
      output += "\n</content>"

      LSP.touchFile(filepath, false)
      await FileTime.read(ctx.sessionID, filepath)

      if (instructions.length > 0) {
        output += `\n\n<system-reminder>\n${instructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
      }

      return {
        title,
        output,
        metadata: {
          preview,
          truncated,
          loaded: instructions.map((i) => i.filepath),
        },
      }
    },
  }
})

async function retry<T>(fn: () => Promise<T>): Promise<T> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await fn()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message.toLowerCase() : ""
      if (msg.includes("bad request") || msg.includes("authentication") || msg.includes("401") || msg.includes("400"))
        throw e
      if (i === MAX_RETRIES - 1) throw e
      const wait = Math.min(0.5 * Math.pow(2, i), 4) * 1000
      log.info("image read retrying", { attempt: i + 1, wait })
      await Bun.sleep(wait)
    }
  }
  throw new Error("unreachable")
}

async function isBinaryFile(filepath: string, fileSize: number): Promise<boolean> {
  const ext = path.extname(filepath).toLowerCase()
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  if (fileSize === 0) return false

  const fh = await fs.open(filepath, "r")
  try {
    const sampleSize = Math.min(4096, fileSize)
    const bytes = Buffer.alloc(sampleSize)
    const result = await fh.read(bytes, 0, sampleSize, 0)
    if (result.bytesRead === 0) return false

    let nonPrintableCount = 0
    for (let i = 0; i < result.bytesRead; i++) {
      if (bytes[i] === 0) return true
      if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
        nonPrintableCount++
      }
    }
    return nonPrintableCount / result.bytesRead > 0.3
  } finally {
    await fh.close()
  }
}
