import z from "zod"
import path from "path"
import { generateText } from "ai"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { Filesystem } from "../util/filesystem"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { Log } from "@/util/log"

const log = Log.create({ service: "image-read-tool" })
const MAX_RETRIES = 5

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
}

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
      log.info("image_read retrying", { attempt: i + 1, wait })
      await Bun.sleep(wait)
    }
  }
  throw new Error("unreachable")
}

export const ImageReadTool = Tool.define("image_read", {
  description:
    "Read and analyze an image file. " +
    "Use this ONLY for image files that you need to visually analyze. " +
    "Do NOT use this for text files — use shell commands (cat, head, etc.) instead. " +
    "The image will be sent to the model for visual analysis " +
    "and you will receive a text description in the next turn.",
  parameters: z.object({
    file_path: z
      .string()
      .describe("Absolute path to the image file. Supported formats: PNG, JPG, JPEG, GIF, WEBP."),
    image_read_instruction: z
      .string()
      .describe(
        "A text instruction describing what you want to learn from the image. " +
          "Be specific about what information to extract.",
      ),
  }),
  async execute(params, ctx) {
    let filepath = params.file_path
    if (!path.isAbsolute(filepath)) filepath = path.resolve(Instance.directory, filepath)
    if (process.platform === "win32") filepath = Filesystem.normalizePath(filepath)

    await assertExternalDirectory(ctx, filepath, { bypass: false, kind: "file" })

    const ext = path.extname(filepath).toLowerCase()
    const mime = MIME[ext]
    if (!mime) {
      return {
        title: `image_read ${path.basename(filepath)}`,
        metadata: {},
        output:
          `ERROR: Unsupported image format '${ext}'. ` +
          `Convert to PNG first (e.g. convert image${ext} to image.png), ` +
          `then use \`image_read\` on the PNG file.`,
      }
    }

    const stat = Filesystem.stat(filepath)
    if (!stat) {
      return {
        title: `image_read ${path.basename(filepath)}`,
        metadata: {},
        output: `ERROR: Failed to read file '${filepath}': No such file or directory`,
      }
    }

    const buf = await Bun.file(filepath).arrayBuffer()
    const b64 = Buffer.from(buf).toString("base64")
    const url = `data:${mime};base64,${b64}`

    // Use separate vision model when configured, otherwise fall back to main model
    const visionModel = ctx.extra?.visionModel as Provider.Model | undefined
    const mainModel = ctx.extra?.model as Provider.Model | undefined
    const model = visionModel ?? mainModel
    if (!model) {
      return {
        title: `image_read ${path.basename(filepath)}`,
        metadata: {},
        output: "ERROR: No model available for image analysis.",
      }
    }

    try {
      const language = await Provider.getLanguage(model)
      const result = await retry(() =>
        generateText({
          model: language,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: params.image_read_instruction },
                { type: "image", image: url },
              ],
            },
          ],
          maxOutputTokens: ProviderTransform.maxOutputTokens(model),
        }),
      )

      return {
        title: `image_read ${path.basename(filepath)}`,
        metadata: {},
        output: `File Read Result for '${filepath}':\n${result.text}`,
      }
    } catch (e: unknown) {
      log.error("image_read LLM call failed", { error: e })
      return {
        title: `image_read ${path.basename(filepath)}`,
        metadata: {},
        output: `ERROR: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
  },
})
