import z from "zod"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Tmux } from "@/tmux/tmux"
import { checkCommandPermissions } from "./bash"

const log = Log.create({ service: "execute-commands-tool" })
const MAX_OUTPUT_BYTES = 30_000
const MAX_METADATA_LENGTH = 30_000

function preview(text: string) {
  if (text.length <= MAX_METADATA_LENGTH) return text
  return text.slice(0, MAX_METADATA_LENGTH) + "\n\n..."
}

function limit(text: string) {
  if (text.length <= MAX_OUTPUT_BYTES) return text
  const half = Math.floor(MAX_OUTPUT_BYTES / 2)
  return text.slice(0, half) + `\n\n... (${text.length - MAX_OUTPUT_BYTES} bytes truncated) ...\n\n` + text.slice(-half)
}

/** Tmux escape sequences that are not real shell commands. */
const TMUX_ESCAPE = /^C-[a-z]$/i

export const ExecuteCommandsTool = Tool.define("execute_commands", {
  description:
    "Call this to execute commands in the terminal with your analysis and plan. " +
    "Returns only new terminal output since the last call, labeled [New output]. " +
    "If nothing new was produced, returns the current visible terminal, labeled [No new output — showing current terminal]. " +
    "Set reset to true to start a fresh shell session if the terminal is stuck (e.g., in a pager or interactive prompt).",
  parameters: z.object({
    analysis: z
      .string()
      .describe(
        "Analyze the current state based on the terminal output provided. " +
          "What do you see? What has been accomplished? What still needs to be done?",
      ),
    plan: z
      .string()
      .describe(
        "Describe your plan for the next steps. " +
          "What commands will you run and why? " +
          "Be specific about what you expect each command to accomplish.",
      ),
    commands: z
      .array(
        z.object({
          keystrokes: z
            .string()
            .describe(
              "String containing the exact keystrokes to send to the terminal. " +
                "Each command sends either a single special key or a string of literal text. " +
                "If the entire string matches a recognized key name, it is sent as that key press. " +
                "Otherwise, the string is typed as literal. " +
                "Recognized key names: Escape, Tab, Up, Down, Left, Right, Home, End, " +
                "PageUp, PageDown, BSpace (backspace), BTab (shift-tab), F1-F12, Space, Enter. " +
                "Modifier prefixes: C- (ctrl), S- (shift), M- (alt) — e.g. C-c, C-d, S-Up, M-a. " +
                "Most bash commands should end with a newline (\\n) to cause them to execute. " +
                "Do not include extra whitespace before or after the keystrokes unless it's part of the intended command.",
            ),
          duration: z
            .number()
            .describe(
              "Number of seconds to wait for the command to complete (default: 1.0) " +
                "before the next command will be executed. " +
                "On immediate tasks (e.g., cd, ls, echo, cat) set a duration of 0.1 seconds. " +
                "On commands (e.g., gcc, find, rustc) set a duration of 1.0 seconds. " +
                "On slow commands (e.g., make, python3 [long running script], wget [file]) set an appropriate duration as you determine necessary. " +
                "It is better to set a smaller duration than a longer duration. " +
                "It is always possible to wait again if the prior output has not finished, " +
                "by running empty keystrokes with a duration on subsequent requests to wait longer. " +
                "Never wait longer than 60 seconds; prefer to poll to see intermediate result status.",
            )
            .optional(),
          literal: z
            .boolean()
            .describe(
              "Override auto-detection to force literal text input. " +
                "When true, keystrokes are always typed as text even if they match a special key name. " +
                "When false (default), recognized key names are sent as key presses " +
                "and everything else is typed literally.",
            )
            .optional(),
        }),
      )
      .describe("The commands array can be empty if you want to wait without taking action."),
    reset: z
      .boolean()
      .describe(
        "If true, destroys the current shell session and starts a fresh one before running commands. " +
          "Use this to recover from stuck states like pagers or interactive prompts.",
      )
      .optional(),
  }),
  async execute(params, ctx) {
    const cwd = Instance.directory
    const commands = params.commands.map((c) => ({
      keystrokes: c.keystrokes,
      duration: Math.min(c.duration ?? 1.0, 60),
      literal: c.literal,
    }))
    const labels = commands.map((c) => c.keystrokes.replace(/\n$/, "").trim()).filter(Boolean)

    ctx.metadata({
      metadata: {
        output: "",
        analysis: params.analysis,
        plan: params.plan,
        commands: labels,
      },
    })

    // Check permissions using the same tree-sitter parsing and external-directory
    // detection as the standalone bash tool. When every rule resolves to "allow"
    // (the common case for the build agent) this returns immediately — no prompt.
    const commandTexts = labels.filter((l) => !TMUX_ESCAPE.test(l))
    await checkCommandPermissions(commandTexts, cwd, ctx)

    if (params.reset) {
      await Tmux.kill(ctx.sessionID)
      log.info("reset shell", { sessionID: ctx.sessionID })
    }

    log.info("execute_commands", { commands: labels.length, sessionID: ctx.sessionID })

    const output = await Tmux.execute(ctx.sessionID, cwd, commands, (partial) => {
      ctx.metadata({
        metadata: {
          output: preview(partial),
          analysis: params.analysis,
          plan: params.plan,
          commands: labels,
        },
      })
    })

    const limited = limit(output)

    let result: string
    if (limited.trim()) {
      result = `[New output]\n${limited}`
    } else {
      const pane = await Tmux.capture(ctx.sessionID)
      result = `[No new output — showing current terminal]\n${limit(pane || "(empty)")}`
    }

    return {
      title: params.plan.slice(0, 80),
      metadata: {
        output: preview(output),
        analysis: params.analysis,
        plan: params.plan,
        commands: labels,
        truncated: output.length > MAX_OUTPUT_BYTES,
      },
      output: result,
    }
  },
})
