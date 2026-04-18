// Shell-side helpers installed into the tmux session's PATH so the model can
// call `write` as a shell command. Patching is done with the system `patch`
// command (unified diffs), which is standard on every Linux container.

import os from "os"
import path from "path"
import { promises as fs } from "fs"
import { Log } from "../util/log"

const log = Log.create({ service: "shell-scripts" })

const WRITE_SCRIPT = `#!/usr/bin/env python3
import os, sys
if len(sys.argv) != 2:
    sys.stderr.write("usage: write <path>\\n")
    sys.exit(2)
p = sys.argv[1]
d = os.path.dirname(os.path.abspath(p))
if d:
    os.makedirs(d, exist_ok=True)
data = sys.stdin.read()
with open(p, "w") as f:
    f.write(data)
sys.stdout.write(f"wrote {len(data)} bytes to {p}\\n")
`

const BIN_DIR = path.join(os.homedir(), ".opencode-bin")
const WRITE_PATH = path.join(BIN_DIR, "write")

/**
 * Write the `write` helper to disk. Idempotent — safe to call repeatedly.
 * Does not touch the tmux session; a separate one-line PATH export is used
 * to expose the helper.
 */
export async function installOnDisk() {
  try {
    await fs.mkdir(BIN_DIR, { recursive: true })
    const existing = await fs.readFile(WRITE_PATH, "utf8").catch(() => "")
    if (existing !== WRITE_SCRIPT) {
      await fs.writeFile(WRITE_PATH, WRITE_SCRIPT, { mode: 0o755 })
    }
    await fs.chmod(WRITE_PATH, 0o755).catch(() => {})
  } catch (err) {
    log.info("install failed", { err: String(err) })
  }
}

/**
 * Shell snippet (one line) that prepends the bin dir to PATH. Short enough
 * to be sent as a single tmux sendKeys call without heredoc complications.
 */
export function pathExport() {
  return `export PATH="${BIN_DIR}:$PATH"`
}
