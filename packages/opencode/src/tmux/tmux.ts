import { Log } from "@/util/log"

const log = Log.create({ service: "tmux" })
const MARKER = "__CMDEND__"
const MARKER_ECHO_RE = /^.*echo\s+'__CMDEND__\d+__'.*$/

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

async function sendKeys(name: string, keystrokes: string) {
  const special = /^C-[a-zA-Z]$/.test(keystrokes.trim())
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
    const name = `oc-${id.slice(0, 8)}`
    log.info("creating tmux session", { name, cwd })
    await run(["tmux", "new-session", "-d", "-s", name, "-x", "200", "-y", "50"])
    await run(["tmux", "set-option", "-t", name, "history-limit", "50000"])
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
    commands: Array<{ keystrokes: string; duration: number }>,
    update?: (output: string) => void,
  ) {
    const state = await ensure(id, cwd)
    if (!(await alive(id))) {
      log.info("tmux session dead, recreating", { id })
      states.delete(id)
      await ensure(id, cwd)
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

      await sendKeys(state.name, cmd.keystrokes)
      if (!cmd.keystrokes.endsWith("\n")) {
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
          update(filterMarkers(delta(before, pane)))
        }
        await Bun.sleep(500)
      }
    }

    const after = await capturePane(state.name)
    const raw = delta(state.prior, after)
    state.prior = after
    return filterMarkers(raw)
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

  export function has(id: string) {
    return states.has(id)
  }
}

function shellEscape(text: string) {
  return `'${text.replace(/'/g, "'\\''")}'`
}
