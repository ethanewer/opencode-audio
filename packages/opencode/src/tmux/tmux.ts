import { Log } from "@/util/log"
import { get as getTmpdir } from "@/session/tmpdir"

const log = Log.create({ service: "tmux" })
const MARKER = "__CMDEND__"
const MARKER_ECHO_RE = /^.*echo\s+'__CMDEND__\d+__'.*$/
const SPECIAL_RE =
  /^(C-[a-zA-Z]|Escape|Tab|BTab|Up|Down|Left|Right|Home|End|PageUp|PageDown|BSpace|DC|IC|F[0-9]+|[SM]-\S+)$/

interface State {
  name: string
  seq: number
  prior: string
}

const states = new Map<string, State>()

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" })
  const text = await new Response(proc.stdout).text()
  await proc.exited
  return text
}

async function sendKeys(name: string, keystrokes: string, literal?: boolean) {
  const special = !literal && SPECIAL_RE.test(keystrokes.trim())
  if (special) {
    await run(["tmux", "send-keys", "-t", name, keystrokes.trim()])
    return
  }
  let text = keystrokes
  let enter = false
  if (text.endsWith("\n")) {
    text = text.slice(0, -1)
    enter = true
  }
  if (text) await run(["tmux", "send-keys", "-t", name, "-l", "--", text])
  if (enter) await run(["tmux", "send-keys", "-t", name, "Enter"])
}

async function capturePane(name: string) {
  return (await run(["tmux", "capture-pane", "-t", name, "-p", "-S", "-"])).trimEnd()
}

const MARKER_OUTPUT_RE = new RegExp(`${MARKER}\\d+__`)
const CHO_ERROR_RE = /command not found:\s*cho\b/
const TRAILING_PROMPT_RE = /^(\S+@\S+[\s:].*?)?[%$#>]\s*$/

function filterMarkers(text: string) {
  return text
    .split("\n")
    .filter((line) => {
      if (MARKER_ECHO_RE.test(line)) return false
      if (MARKER_OUTPUT_RE.test(line)) return false
      if (CHO_ERROR_RE.test(line)) return false
      return true
    })
    .join("\n")
}

function stripPrompt(text: string) {
  const lines = text.split("\n")
  while (lines.length > 0 && TRAILING_PROMPT_RE.test(lines[lines.length - 1]!)) lines.pop()
  return lines.join("\n")
}

function delta(prior: string, current: string) {
  if (!prior) return current
  const pl = prior.split("\n")
  const cl = current.split("\n")
  let i = 0
  while (i < pl.length && i < cl.length && pl[i] === cl[i]) i++
  return cl.slice(i).join("\n")
}

export namespace Tmux {
  export async function available() {
    const proc = Bun.spawn(["which", "tmux"], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    return proc.exitCode === 0
  }

  export async function ensure(id: string, cwd: string) {
    let state = states.get(id)
    if (state) return state
    const name = `oc-${id.slice(0, 20)}`
    log.info("creating tmux session", { name, cwd })
    // Kill any stale session with this name from a previous process or collision
    await run(["tmux", "kill-session", "-t", name]).catch(() => {})
    const proc = Bun.spawn(["tmux", "new-session", "-d", "-s", name, "-x", "200", "-y", "50"], {
      stdout: "pipe",
      stderr: "pipe",
    })
    await proc.exited
    if (proc.exitCode !== 0) {
      throw new Error(`Failed to create tmux session '${name}'. Is tmux installed and working?`)
    }
    await run(["tmux", "set-option", "-t", name, "history-limit", "50000"])
    const tmpdir = getTmpdir(id)
    await sendKeys(
      name,
      `export TMPDIR=${shellEscape(tmpdir)} TMP=${shellEscape(tmpdir)} TEMP=${shellEscape(tmpdir)}\n`,
    )
    await sendKeys(name, `cd ${shellEscape(cwd)}\n`)
    await Bun.sleep(300)
    const prior = await capturePane(name)
    state = { name, seq: 0, prior }
    states.set(id, state)
    return state
  }

  export async function alive(id: string) {
    const state = states.get(id)
    if (!state) return false
    const proc = Bun.spawn(["tmux", "has-session", "-t", state.name], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    return proc.exitCode === 0
  }

  export async function execute(
    id: string,
    cwd: string,
    commands: Array<{ keystrokes: string; duration: number; literal?: boolean }>,
    update?: (output: string) => void,
  ) {
    let state = await ensure(id, cwd)
    if (!(await alive(id))) {
      log.info("tmux session dead, recreating", { id })
      states.delete(id)
      state = await ensure(id, cwd)
    }
    const before = await capturePane(state.name)

    for (const cmd of commands) {
      const keys = cmd.keystrokes.replace(/\n$/, "").trim()
      if (!keys) {
        await Bun.sleep(cmd.duration * 1000)
        continue
      }
      state.seq++
      const marker = `${MARKER}${state.seq}__`
      const start = performance.now()

      await sendKeys(state.name, cmd.keystrokes, cmd.literal)
      const special = !cmd.literal && SPECIAL_RE.test(cmd.keystrokes.trim())
      if (special || (cmd.literal && !cmd.keystrokes.endsWith("\n"))) {
        await Bun.sleep(cmd.duration * 1000)
      } else {
        // Auto-press Enter when the model omits trailing \n
        if (!cmd.literal && !cmd.keystrokes.endsWith("\n")) {
          await run(["tmux", "send-keys", "-t", state.name, "Enter"])
        }
        await Bun.sleep(50)
        await sendKeys(state.name, `echo '${marker}'\n`)

        const wait = Math.min(0.3, cmd.duration) * 1000
        await Bun.sleep(wait)

        while ((performance.now() - start) / 1000 < cmd.duration) {
          const pane = await capturePane(state.name)
          if (pane.split("\n").some((line) => line.includes(marker) && !MARKER_ECHO_RE.test(line))) break
          if (update) {
            update(stripPrompt(filterMarkers(delta(before, pane))))
          }
          await Bun.sleep(500)
        }
      }
    }

    const after = await capturePane(state.name)
    const raw = delta(state.prior, after)
    state.prior = after
    return stripPrompt(filterMarkers(raw))
  }

  export async function capture(id: string) {
    const state = states.get(id)
    if (!state) return ""
    return capturePane(state.name)
  }

  export async function kill(id: string) {
    const state = states.get(id)
    if (!state) return
    log.info("killing tmux session", { name: state.name })
    await run(["tmux", "kill-session", "-t", state.name]).catch(() => {})
    states.delete(id)
  }

  export async function killAll() {
    const entries = [...states.entries()]
    await Promise.allSettled(
      entries.map(async ([id, state]) => {
        await run(["tmux", "kill-session", "-t", state.name]).catch(() => {})
        states.delete(id)
      }),
    )
  }

  export function has(id: string) {
    return states.has(id)
  }
}

function shellEscape(text: string) {
  return `'${text.replace(/'/g, "'\\''")}'`
}
