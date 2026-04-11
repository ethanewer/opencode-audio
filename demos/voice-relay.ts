#!/usr/bin/env bun
/**
 * Voice SDK Two-Agent Codeword Relay Challenge (Autonomous)
 *
 * Two voice SDK sessions in separate sandboxes are wired together
 * bidirectionally: A's audio output feeds B's input and vice versa.
 * A seed message is pushed to Agent A, and then the system runs
 * autonomously until both agents have completed the challenge.
 *
 * Each sandbox has 3 execute-only, XOR-obfuscated binaries
 * (step1, step2, step3). The codeword chain is interleaved:
 *
 *   AURORA -> A.step1 -> FALCON -> B.step1 -> MARBLE
 *   MARBLE -> A.step2 -> THUNDER -> B.step2 -> PRISM
 *   PRISM  -> A.step3 -> ZENITH  -> B.step3 -> SUMMIT
 *
 * Both agents must write their final codeword to result.txt.
 * The test passes iff sandbox A contains ZENITH and B contains SUMMIT.
 *
 * Features:
 *   - Full SSE event logging (tool calls, status, text deltas)
 *   - Audio recordings saved to disk for later review
 *   - Tool call tracking (verifies task_complete is called)
 *   - Selectable voice system via --system flag
 *
 * Usage:
 *   bun run demos/voice-relay.ts
 *   bun run demos/voice-relay.ts --system gpt-audio-voice
 *   bun run demos/voice-relay.ts --system claude-opus-medium-voice
 */

import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { createOpencodeClient } from "../packages/sdk/js/src/v2/client"
import {
  createVoiceSession,
  stt,
  tts,
  pcmToWav,
  type VoiceSession,
  type VoiceSystemName,
  voiceSystems,
} from "../packages/sdk/js/src/v2/voice"
import type { Event } from "../packages/sdk/js/src/v2/gen/types.gen"

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2)
const systemFlag = args.find((a) => a.startsWith("--system="))?.split("=")[1] ?? args[args.indexOf("--system") + 1]
const SYSTEM = (systemFlag ?? "claude-opus-medium-voice") as VoiceSystemName

if (!(SYSTEM in voiceSystems)) {
  console.error(`Unknown system: ${SYSTEM}`)
  console.error(`Available: ${Object.keys(voiceSystems).join(", ")}`)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dir, "..")
const OPENCODE_DIR = path.join(ROOT, "packages/opencode")
const OPENCODE_SRC = path.join(OPENCODE_DIR, "src/index.ts")
const PCM = { sampleRate: 24000, channels: 1, bitDepth: 16 } as const
const PORT = 19001
const DEADLINE_MS = 5 * 60 * 1000

const CHAIN = ["AURORA", "FALCON", "MARBLE", "THUNDER", "PRISM", "ZENITH", "SUMMIT"] as const

const STEPS_A = [
  { input: CHAIN[0], output: CHAIN[1] },
  { input: CHAIN[2], output: CHAIN[3] },
  { input: CHAIN[4], output: CHAIN[5] },
]
const STEPS_B = [
  { input: CHAIN[1], output: CHAIN[2] },
  { input: CHAIN[3], output: CHAIN[4] },
  { input: CHAIN[5], output: CHAIN[6] },
]

// ---------------------------------------------------------------------------
// Output directory for recordings and logs
// ---------------------------------------------------------------------------

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)
const OUT_DIR = path.join(ROOT, "demos", "output", `relay-${SYSTEM}-${RUN_ID}`)

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

const logs: string[] = []

function log(tag: string, msg: string) {
  const ts = new Date().toISOString().slice(11, 23)
  const line = `[${ts}] [${tag}] ${msg}`
  console.log(line)
  logs.push(line)
}

// ---------------------------------------------------------------------------
// Tool call tracking
// ---------------------------------------------------------------------------

type ToolRecord = {
  agent: string
  tool: string
  status: string
  input: unknown
  output?: string
  time: number
}

const toolCalls: ToolRecord[] = []

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const buf = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    buf.set(c, off)
    off += c.length
  }
  return buf
}

async function save(name: string, data: Uint8Array) {
  const file = path.join(OUT_DIR, name)
  await fs.writeFile(file, data)
  log("SAVE", `${name} (${(data.length / 1024).toFixed(1)} KB)`)
}

// ---------------------------------------------------------------------------
// Binary generation
// ---------------------------------------------------------------------------

function xor(text: string, key: number): number[] {
  return [...text].map((c) => c.charCodeAt(0) ^ key)
}

function genC(input: string, output: string): string {
  const key = 0x41 + Math.floor(Math.random() * 0x3e)
  const ei = xor(input, key)
  const eo = xor(output, key)
  return `#include <stdio.h>
#include <string.h>
static unsigned char a[]={${ei.join(",")}};
static unsigned char b[]={${eo.join(",")}};
int main(void){
  char l[256]={0};
  if(!fgets(l,256,stdin)){fprintf(stderr,"error: no input\\n");return 1;}
  l[strcspn(l,"\\n")]=0;
  for(int i=0;l[i];i++){if(l[i]>='a'&&l[i]<='z')l[i]-=32;}
  char d[256]={0};
  for(unsigned i=0;i<sizeof(a);i++)d[i]=a[i]^${key};
  if(strcmp(l,d)){fprintf(stderr,"error: wrong codeword\\n");return 1;}
  char o[256]={0};
  for(unsigned i=0;i<sizeof(b);i++)o[i]=b[i]^${key};
  printf("%s\\n",o);
  return 0;
}
`
}

async function build(dir: string, steps: { input: string; output: string }[], label: string) {
  for (const [i, step] of steps.entries()) {
    const name = `step${i + 1}`
    const src = path.join(dir, `${name}.c`)
    const bin = path.join(dir, name)

    await fs.writeFile(src, genC(step.input, step.output))

    const cc = Bun.spawn(["cc", "-O2", "-o", bin, src], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    if ((await cc.exited) !== 0) {
      const err = await new Response(cc.stderr).text()
      throw new Error(`cc failed for ${label}/${name}: ${err}`)
    }

    await Bun.spawn(["strip", bin], { stdout: "ignore", stderr: "ignore" }).exited
    await fs.unlink(src)
    await fs.chmod(bin, 0o111)

    const ok = Bun.spawn(["sh", "-c", `echo "${step.input}" | "./${name}"`], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = (await new Response(ok.stdout).text()).trim()
    if ((await ok.exited) !== 0 || out !== step.output) {
      throw new Error(`Smoke test failed: ${label}/${name}`)
    }
    log("BUILD", `${label}/${name}: "${step.input}" -> "${step.output}" OK`)
  }
}

// ---------------------------------------------------------------------------
// Sandbox & server
// ---------------------------------------------------------------------------

async function sandbox(label: string): Promise<string> {
  const dir = path.join(os.tmpdir(), `voice-sdk-${label}-${Date.now()}`)
  await fs.mkdir(dir, { recursive: true })
  for (const cmd of [
    ["init"],
    ["config", "user.email", "test@test.com"],
    ["config", "user.name", "Test"],
    ["config", "core.fsmonitor", "false"],
    ["commit", "--allow-empty", "-m", "init"],
  ] as const) {
    await Bun.spawn(["git", ...cmd], {
      cwd: dir,
      stdout: "ignore",
      stderr: "ignore",
    }).exited
  }
  return fs.realpath(dir)
}

async function spawnServer(port: number) {
  const data = path.join(os.tmpdir(), `voice-sdk-data-${port}-${Date.now()}`)
  await fs.mkdir(data, { recursive: true })

  const proc = Bun.spawn(
    ["bun", "run", "--conditions=browser", OPENCODE_SRC, "serve", `--port=${port}`, "--hostname=127.0.0.1"],
    {
      cwd: OPENCODE_DIR,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, XDG_DATA_HOME: data },
    },
  )

  let stderr = ""
  ;(async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      stderr += new TextDecoder().decode(value)
      if (stderr.length > 8192) stderr = stderr.slice(-4096)
    }
  })()

  const url = await new Promise<string>((resolve, reject) => {
    let found = false
    const timer = setTimeout(() => {
      if (!found) reject(new Error(`Server :${port} timed out\n${stderr.slice(-2000)}`))
    }, 60_000)
    proc.exited.then((code) => {
      if (!found) {
        clearTimeout(timer)
        reject(new Error(`Server exited ${code}\n${stderr.slice(-2000)}`))
      }
    })
    let buf = ""
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    ;(async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += new TextDecoder().decode(value)
        if (!found) {
          const m = buf.match(/listening on (http\S+)/)
          if (m?.[1]) {
            found = true
            clearTimeout(timer)
            resolve(m[1])
          }
        }
      }
      if (!found) {
        clearTimeout(timer)
        reject(new Error(`Server stdout ended\n${stderr.slice(-2000)}`))
      }
    })()
  })

  return {
    url,
    data,
    close() {
      proc.kill()
    },
  }
}

// ---------------------------------------------------------------------------
// Audio helpers
// ---------------------------------------------------------------------------

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return concat(chunks)
}

async function collectTurn(
  output: VoiceSession["output"],
  label: string,
  first = 180_000,
  gap = 15_000,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []

  const r0 = await Promise.race([
    output.next(),
    new Promise<IteratorResult<Uint8Array>>((_, rej) =>
      setTimeout(() => rej(new Error(`${label}: no output within ${first / 1000}s`)), first),
    ),
  ])
  if (r0.done) throw new Error(`${label}: output closed`)
  chunks.push(r0.value)

  while (true) {
    const r = await Promise.race([
      output.next(),
      new Promise<IteratorResult<Uint8Array>>((res) =>
        setTimeout(() => res({ value: undefined as any, done: true }), gap),
      ),
    ])
    if (r.done) break
    chunks.push(r.value)
  }

  const pcm = concat(chunks)
  log(label, `${chunks.length} chunks, ${(pcm.length / 1024).toFixed(1)} KB`)
  return pcm
}

// ---------------------------------------------------------------------------
// SSE event observer — logs all events and tracks tool calls
// ---------------------------------------------------------------------------

function observe(
  client: ReturnType<typeof createOpencodeClient>,
  sessionID: string,
  label: string,
  ctrl: AbortController,
) {
  const loop = (async () => {
    const events = await client.event.subscribe({}, { signal: ctrl.signal })
    try {
      for await (const event of events.stream) {
        const evt = event as Event
        if (!("properties" in evt) || !("sessionID" in (evt as any).properties)) continue
        if ((evt as any).properties.sessionID !== sessionID) continue

        if (evt.type === "message.part.updated") {
          const part = evt.properties.part
          if (part.type === "tool") {
            const state = part.state
            const rec: ToolRecord = {
              agent: label,
              tool: part.tool,
              status: state.status,
              input: state.input,
              time: Date.now(),
            }
            if (state.status === "completed") {
              rec.output = state.output
              log(
                `${label}/TOOL`,
                `${part.tool} completed — input: ${JSON.stringify(state.input)} output: ${state.output.slice(0, 200)}`,
              )
            } else if (state.status === "running") {
              log(`${label}/TOOL`, `${part.tool} running — input: ${JSON.stringify(state.input)}`)
            } else if (state.status === "error") {
              rec.output = state.error
              log(`${label}/TOOL`, `${part.tool} error — ${state.error}`)
            } else if (state.status === "pending") {
              log(`${label}/TOOL`, `${part.tool} pending`)
            }
            toolCalls.push(rec)
          } else if (part.type === "file") {
            log(`${label}/FILE`, `${part.mime} ${part.url?.length ?? 0} chars`)
          } else if (part.type === "text") {
            log(`${label}/TEXT`, `${(part as any).text?.slice(0, 150)}`)
          }
        } else if (evt.type === "session.status") {
          log(`${label}/STATUS`, `${evt.properties.status.type}`)
        } else if (evt.type === "session.error") {
          log(`${label}/ERROR`, JSON.stringify((evt as any).properties).slice(0, 300))
        }
      }
    } catch {
      // stream ended
    }
  })()
  return loop
}

// ---------------------------------------------------------------------------
// Bidirectional relay with audio saving
// ---------------------------------------------------------------------------

async function relay(
  from: VoiceSession,
  to: VoiceSession,
  label: string,
  transcripts: { agent: string; turn: number; text: string }[],
  pending: Promise<void>[],
) {
  let turn = 0
  while (true) {
    turn++
    try {
      const pcm = await collectTurn(from.output, `${label}/t${turn}`)
      if (pcm.length === 0) continue
      const wav = pcmToWav(pcm, PCM)

      // Save audio to disk
      const t = turn
      pending.push(save(`${label}-turn-${t}.wav`, wav))

      // Forward immediately
      if (!to.input.closed) to.input.push(wav)

      // Transcribe in background
      pending.push(
        stt(wav)
          .then((text) => {
            log(label, `Turn ${t}: "${text}"`)
            transcripts.push({ agent: label, turn: t, text })
          })
          .catch((err) => {
            log(label, `Turn ${t}: STT failed — ${err}`)
          }),
      )
    } catch {
      log(label, `Relay stopped after ${turn - 1} turn(s)`)
      break
    }
  }
}

// ---------------------------------------------------------------------------
// Agent prompts
// ---------------------------------------------------------------------------

const PROMPT_A = `You are Agent A in a codeword relay challenge with Agent B.

YOUR WORKSPACE has 3 execute-only binaries: ./step1, ./step2, ./step3
Each reads a codeword from stdin and prints the next codeword.
You CANNOT read them — they are execute-only. Do NOT try cat/strings/xxd.
Run them like:  echo "WORD" | ./step1

PROTOCOL (follow in order):
  Round 1: Run  echo "AURORA" | ./step1  — tell Agent B the output.
  Round 2: Agent B will tell you a codeword. Run  echo "THAT_WORD" | ./step2  — tell Agent B the output.
  Round 3: Agent B will tell you a codeword. Run  echo "THAT_WORD" | ./step3  — tell Agent B the output.
           Also write your step3 output to result.txt:  echo "OUTPUT" > result.txt

RULES:
- The seed for step1 is AURORA.
- For step2 and step3, use EXACTLY the codeword Agent B tells you (uppercase).
- State each codeword clearly and briefly. No extra commentary.`

const PROMPT_B = `You are Agent B in a codeword relay challenge with Agent A.

YOUR WORKSPACE has 3 execute-only binaries: ./step1, ./step2, ./step3
Each reads a codeword from stdin and prints the next codeword.
You CANNOT read them — they are execute-only. Do NOT try cat/strings/xxd.
Run them like:  echo "WORD" | ./step1

PROTOCOL (follow in order):
  Round 1: Agent A will tell you a codeword. Run  echo "THAT_WORD" | ./step1  — tell Agent A the output.
  Round 2: Agent A will tell you a codeword. Run  echo "THAT_WORD" | ./step2  — tell Agent A the output.
  Round 3: Agent A will tell you a codeword. Run  echo "THAT_WORD" | ./step3
           Write the output to result.txt:  echo "OUTPUT" > result.txt
           Then tell Agent A you are done.

RULES:
- For every step, use EXACTLY the codeword Agent A tells you (uppercase).
- State each codeword clearly and briefly. No extra commentary.`

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })

  console.log("==============================================")
  console.log("  Voice SDK Codeword Relay (Autonomous)")
  console.log("==============================================")
  console.log()
  console.log(`  System:  ${SYSTEM}`)
  console.log(`  Chain:   ${CHAIN.join(" -> ")}`)
  console.log(`  Output:  ${OUT_DIR}`)
  console.log()

  log("SETUP", `System: ${SYSTEM}`)
  log("SETUP", `Output: ${OUT_DIR}`)

  // ---- Setup ----
  log("SETUP", "Creating sandboxes...")
  const [dirA, dirB] = await Promise.all([sandbox("a"), sandbox("b")])
  log("SETUP", `Sandbox A: ${dirA}`)
  log("SETUP", `Sandbox B: ${dirB}`)

  log("BUILD", "Compiling step binaries...")
  await Promise.all([build(dirA, STEPS_A, "A"), build(dirB, STEPS_B, "B")])

  log("SETUP", "Starting opencode dev server...")
  const srv = await spawnServer(PORT)
  log("SETUP", `Server ready: ${srv.url}`)

  try {
    const clientA = createOpencodeClient({ baseUrl: srv.url, directory: dirA })
    const clientB = createOpencodeClient({ baseUrl: srv.url, directory: dirB })

    log("SETUP", "Creating voice sessions...")
    const [sessionA, sessionB] = await Promise.all([
      createVoiceSession(clientA, {
        system: SYSTEM,
        permission: "dangerous",
        prompt: PROMPT_A,
      }),
      createVoiceSession(clientB, {
        system: SYSTEM,
        permission: "dangerous",
        prompt: PROMPT_B,
      }),
    ])
    log("SETUP", `Session A: ${sessionA.sessionID}`)
    log("SETUP", `Session B: ${sessionB.sessionID}`)

    // ---- Start SSE observers for tool tracking ----
    const obsCtrl = new AbortController()
    const obsA = observe(clientA, sessionA.sessionID, "A", obsCtrl)
    const obsB = observe(clientB, sessionB.sessionID, "B", obsCtrl)

    // ---- Wire up bidirectional relay ----
    const transcripts: { agent: string; turn: number; text: string }[] = []
    const pending: Promise<void>[] = []

    const relayAB = relay(sessionA, sessionB, "A", transcripts, pending)
    const relayBA = relay(sessionB, sessionA, "B", transcripts, pending)

    // ---- Seed ----
    log("SEED", "Generating seed audio via TTS...")
    const seedPcm = await readStream(
      await tts("Hello Agent A. The seed codeword is AURORA. Please begin by running step one with AURORA."),
    )
    const seedWav = pcmToWav(seedPcm, PCM)
    log("SEED", `Seed WAV: ${(seedWav.length / 1024).toFixed(1)} KB`)
    await save("seed.wav", seedWav)

    sessionA.input.push(seedWav)
    log("SEED", "Seed pushed — agents are now running autonomously")

    // ---- Poll for completion ----
    const deadline = Date.now() + DEADLINE_MS
    let foundA = false
    let foundB = false

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3_000))
      if (!foundA)
        foundA = await fs
          .access(path.join(dirA, "result.txt"))
          .then(() => true)
          .catch(() => false)
      if (!foundB)
        foundB = await fs
          .access(path.join(dirB, "result.txt"))
          .then(() => true)
          .catch(() => false)

      if (foundA && foundB) {
        log("POLL", "Both result.txt files detected!")
        break
      }
      log("POLL", `A=${foundA ? "done" : "waiting"} B=${foundB ? "done" : "waiting"}`)
    }

    if (!foundA || !foundB) {
      log("POLL", `Deadline reached — A=${foundA} B=${foundB}`)
    }

    // Grace period for final audio
    await new Promise((r) => setTimeout(r, 5_000))

    // ---- Shutdown ----
    log("CLEANUP", "Closing sessions...")
    sessionA.close()
    sessionB.close()
    obsCtrl.abort()

    await Promise.allSettled([relayAB, relayBA, obsA, obsB])
    await Promise.allSettled(pending)

    // ---- Verify results ----
    console.log("\n==============================================")
    console.log("  Verification")
    console.log("==============================================\n")

    const expected = { A: CHAIN[5], B: CHAIN[6] }
    let passA = false
    let passB = false

    try {
      const content = (await fs.readFile(path.join(dirA, "result.txt"), "utf-8")).trim()
      passA = content.toUpperCase().includes(expected.A)
      log("VERIFY", `A result.txt: "${content}" (expect ${expected.A}) -> ${passA ? "PASS" : "FAIL"}`)
    } catch {
      log("VERIFY", `FAIL — result.txt not found in sandbox A (expect ${expected.A})`)
    }

    try {
      const content = (await fs.readFile(path.join(dirB, "result.txt"), "utf-8")).trim()
      passB = content.toUpperCase().includes(expected.B)
      log("VERIFY", `B result.txt: "${content}" (expect ${expected.B}) -> ${passB ? "PASS" : "FAIL"}`)
    } catch {
      log("VERIFY", `FAIL — result.txt not found in sandbox B (expect ${expected.B})`)
    }

    // ---- Tool call analysis ----
    console.log("\n==============================================")
    console.log("  Tool Calls")
    console.log("==============================================\n")

    const completed = toolCalls.filter((t) => t.status === "completed")
    const byAgent = (agent: string) => completed.filter((t) => t.agent === agent)
    const byTool = (agent: string, tool: string) => byAgent(agent).filter((t) => t.tool === tool)

    for (const agent of ["A", "B"]) {
      const calls = byAgent(agent)
      const names = [...new Set(calls.map((t) => t.tool))]
      log("TOOLS", `Agent ${agent}: ${calls.length} completed tool calls`)
      for (const name of names) {
        log("TOOLS", `  ${name}: ${byTool(agent, name).length}x`)
      }
      const tc = byTool(agent, "task_complete")
      if (tc.length > 0 && tc[0]) {
        log("TOOLS", `  task_complete input: ${JSON.stringify(tc[0].input)}`)
        log("TOOLS", `  task_complete output: ${tc[0].output ?? ""}`)
      }
    }

    const aComplete = byTool("A", "task_complete").length > 0
    const bComplete = byTool("B", "task_complete").length > 0
    log("VERIFY", `Agent A called task_complete: ${aComplete ? "YES" : "NO"}`)
    log("VERIFY", `Agent B called task_complete: ${bComplete ? "YES" : "NO"}`)

    // ---- Transcripts ----
    console.log("\n==============================================")
    console.log("  Results")
    console.log("==============================================\n")

    transcripts.sort((a, b) => a.turn - b.turn || a.agent.localeCompare(b.agent))
    console.log("Transcripts:")
    for (const t of transcripts) {
      console.log(`  [${t.agent} turn ${t.turn}]: "${t.text}"`)
    }

    console.log()
    console.log("Chain: " + CHAIN.join(" -> "))
    console.log()
    console.log(`  Agent A final (${expected.A}):  ${passA ? "PASS" : "FAIL"}`)
    console.log(`  Agent B final (${expected.B}):  ${passB ? "PASS" : "FAIL"}`)
    console.log(`  Agent A task_complete:          ${aComplete ? "YES" : "NO"}`)
    console.log(`  Agent B task_complete:          ${bComplete ? "YES" : "NO"}`)
    console.log()
    console.log(`  Overall: ${passA && passB ? "PASS" : "FAIL"}`)

    // ---- Save logs ----
    await fs.writeFile(path.join(OUT_DIR, "log.txt"), logs.join("\n") + "\n")
    await fs.writeFile(path.join(OUT_DIR, "tools.json"), JSON.stringify(toolCalls, null, 2))
    await fs.writeFile(path.join(OUT_DIR, "transcripts.json"), JSON.stringify(transcripts, null, 2))
    log("SAVE", "Wrote log.txt, tools.json, transcripts.json")

    if (!passA || !passB) process.exit(1)
  } finally {
    log("CLEANUP", "Stopping server and removing temp dirs...")
    srv.close()
    await new Promise((r) => setTimeout(r, 1_000))
    await Promise.all([
      fs.rm(dirA, { recursive: true, force: true }).catch(() => {}),
      fs.rm(dirB, { recursive: true, force: true }).catch(() => {}),
      fs.rm(srv.data, { recursive: true, force: true }).catch(() => {}),
    ])
  }
}

main().catch((err) => {
  console.error("\nFatal:", err)
  process.exit(1)
})
