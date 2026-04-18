// Shell-side helpers installed into the tmux session's PATH so the model can
// call `write` and `patch` as shell commands — no line numbers required.

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

// Search/replace patch helper.
//
// Usage:
//   patch [--all] <path> <<'EOF'
//   <<<
//   old exact text
//   ===
//   new text
//   >>>
//   EOF
//
// Multiple <<<...===...>>> blocks may be stacked. Without --all, each
// block's search text must appear exactly once in the file. With --all,
// every occurrence is replaced. Empty search text (<<< immediately followed
// by ===) creates a new file or prepends content.
const PATCH_SCRIPT = `#!/usr/bin/env python3
import os, sys
def die(msg, code=1):
    sys.stderr.write(msg.rstrip("\\n") + "\\n")
    sys.exit(code)
args = sys.argv[1:]
all_flag = False
rest = []
for a in args:
    if a == "--all":
        all_flag = True
    else:
        rest.append(a)
if len(rest) != 1:
    die("usage: patch [--all] <path>", 2)
p = rest[0]
raw = sys.stdin.read()
lines = raw.split("\\n")
blocks = []
i = 0
while i < len(lines):
    stripped = lines[i].rstrip()
    if stripped == "<<<":
        start = i + 1
        sep = None
        end = None
        for j in range(start, len(lines)):
            rs = lines[j].rstrip()
            if rs == "===" and sep is None:
                sep = j
            elif rs == ">>>":
                end = j
                break
        if sep is None or end is None:
            die(f"malformed patch block near line {i+1}: missing '===' or '>>>'")
        old = "\\n".join(lines[start:sep])
        new = "\\n".join(lines[sep+1:end])
        blocks.append((old, new))
        i = end + 1
    else:
        if stripped:
            die(f"unexpected content at line {i+1}: {lines[i][:80]!r} (expected '<<<' or blank)")
        i += 1
if not blocks:
    die("no patch blocks found (expected <<<...===...>>>)")
if os.path.exists(p):
    with open(p) as f:
        content = f.read()
else:
    content = ""
for idx, (old, new) in enumerate(blocks, start=1):
    if old == "":
        content = new + content
        continue
    count = content.count(old)
    if count == 0:
        die(f"block {idx}: search text not found in {p}")
    if count > 1 and not all_flag:
        die(f"block {idx}: search text matches {count} times in {p}; add context to make it unique, or pass --all to replace all")
    if all_flag:
        content = content.replace(old, new)
    else:
        content = content.replace(old, new, 1)
d = os.path.dirname(os.path.abspath(p))
if d:
    os.makedirs(d, exist_ok=True)
with open(p, "w") as f:
    f.write(content)
sys.stdout.write(f"applied {len(blocks)} block(s) to {p}\\n")
`

const BIN_DIR = path.join(os.homedir(), ".opencode-bin")
const WRITE_PATH = path.join(BIN_DIR, "write")
const PATCH_PATH = path.join(BIN_DIR, "patch")

async function writeIfDifferent(target: string, content: string) {
  const existing = await fs.readFile(target, "utf8").catch(() => "")
  if (existing !== content) {
    await fs.writeFile(target, content, { mode: 0o755 })
  }
  await fs.chmod(target, 0o755).catch(() => {})
}

/**
 * Write the `write` and `patch` helpers to disk. Idempotent — safe to call
 * repeatedly. Shadows the system `patch(1)` inside the model's PATH because
 * the model-facing `patch` here uses search/replace blocks, not unified
 * diffs. The system patch remains available elsewhere on PATH if the model
 * ever wants to `/usr/bin/patch` explicitly.
 */
export async function installOnDisk() {
  try {
    await fs.mkdir(BIN_DIR, { recursive: true })
    await writeIfDifferent(WRITE_PATH, WRITE_SCRIPT)
    await writeIfDifferent(PATCH_PATH, PATCH_SCRIPT)
  } catch (err) {
    log.info("install failed", { err: String(err) })
  }
}

/** One-line PATH prepend sent via a single tmux sendKeys. */
export function pathExport() {
  return `export PATH="${BIN_DIR}:$PATH"`
}
