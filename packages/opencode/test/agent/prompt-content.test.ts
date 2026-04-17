import { describe, expect, test } from "bun:test"
import path from "path"
import { Permission } from "../../src/permission"

/**
 * Content assertions for all prompt files and key system messages.
 * These tests catch regressions in prompt text that controls agent behavior.
 */

const SRC = path.resolve(__dirname, "../../src")

async function readPrompt(relativePath: string): Promise<string> {
  return Bun.file(path.join(SRC, relativePath)).text()
}

// ── eval agent prompt ─────────────────────────────────────────────

describe("eval agent prompt (agent/prompt/eval.txt)", () => {
  let text: string
  test.each([0])("load", async () => {
    text = await readPrompt("agent/prompt/eval.txt")
  })

  test("has Restrictions section", async () => {
    const t = await readPrompt("agent/prompt/eval.txt")
    expect(t).toContain("<restrictions>")
  })

  test("forbids modifying repository files", async () => {
    const t = await readPrompt("agent/prompt/eval.txt")
    expect(t).toContain("Do NOT modify repository files")
  })

  test("forbids destructive shell commands", async () => {
    const t = await readPrompt("agent/prompt/eval.txt")
    expect(t).toContain("Do NOT run commands that write to the repository")
  })

  test("instructs not to ask user questions", async () => {
    const t = await readPrompt("agent/prompt/eval.txt")
    expect(t).toContain("Do not ask questions")
  })

  test("requires calling eval_result exactly once", async () => {
    const t = await readPrompt("agent/prompt/eval.txt")
    expect(t).toContain("eval_result exactly once")
  })

  test("has Evaluation process section", async () => {
    const t = await readPrompt("agent/prompt/eval.txt")
    expect(t).toContain("<process>")
  })

  test("has Guidelines section", async () => {
    const t = await readPrompt("agent/prompt/eval.txt")
    expect(t).toContain("<guidelines>")
  })

  test("has Calling eval_result section", async () => {
    const t = await readPrompt("agent/prompt/eval.txt")
    expect(t).toContain("<eval_result>")
  })

  test("mentions failing tests as clear failure", async () => {
    const t = await readPrompt("agent/prompt/eval.txt")
    expect(t).toContain("failing tests")
  })
})

// ── extract agent prompt ──────────────────────────────────────────

describe("extract agent prompt (agent/prompt/extract.txt)", () => {
  test("identifies as instruction extraction agent", async () => {
    const t = await readPrompt("agent/prompt/extract.txt")
    expect(t).toContain("instruction extraction agent")
  })

  test("forbids calling tools", async () => {
    const t = await readPrompt("agent/prompt/extract.txt")
    expect(t).toContain("Do not call any tools")
  })

  test("requires imperative form output", async () => {
    const t = await readPrompt("agent/prompt/extract.txt")
    expect(t).toContain("imperative form")
  })

  test("forbids adding requirements user did not state", async () => {
    const t = await readPrompt("agent/prompt/extract.txt")
    expect(t).toContain("Do not add requirements the user did not state")
  })

  test("handles user corrections", async () => {
    const t = await readPrompt("agent/prompt/extract.txt")
    expect(t).toContain("changed their mind")
  })

  test("preserves language", async () => {
    const t = await readPrompt("agent/prompt/extract.txt")
    expect(t).toContain("same language the user used")
  })
})

// ── eval command template ─────────────────────────────────────────

describe("eval command template (command/template/eval.txt)", () => {
  test("contains instruction placeholder", async () => {
    const t = await readPrompt("command/template/eval.txt")
    expect(t).toContain("__EVAL_INSTRUCTION__")
  })

  test("contains context placeholder", async () => {
    const t = await readPrompt("command/template/eval.txt")
    expect(t).toContain("__EVAL_CONTEXT__")
  })

  test("references eval_result tool", async () => {
    const t = await readPrompt("command/template/eval.txt")
    expect(t).toContain("eval_result")
  })

  test("does not mention rebuttal", async () => {
    const t = await readPrompt("command/template/eval.txt")
    expect(t).not.toContain("rebuttal")
  })
})

// ── eval_result tool description ──────────────────────────────────

describe("eval_result tool description (tool/eval.txt)", () => {
  test("requires calling exactly once", async () => {
    const t = await readPrompt("tool/eval.txt")
    expect(t).toContain("exactly once")
  })

  test("describes pass=true for correct work", async () => {
    const t = await readPrompt("tool/eval.txt")
    expect(t).toContain("pass to true")
  })

  test("describes pass=false for problems", async () => {
    const t = await readPrompt("tool/eval.txt")
    expect(t).toContain("pass to false")
  })

  test("references issues array", async () => {
    const t = await readPrompt("tool/eval.txt")
    expect(t).toContain("issues")
  })

  test("mentions severity levels", async () => {
    const t = await readPrompt("tool/eval.txt")
    expect(t).toContain("severity")
  })
})

// ── Permission.RejectedError message ──────────────────────────────

describe("Permission.RejectedError message", () => {
  test("suggests alternative approach", () => {
    const err = new Permission.RejectedError()
    expect(err.message).toContain("alternative approach")
  })

  test("suggests proceeding without the permission", () => {
    const err = new Permission.RejectedError()
    expect(err.message).toContain("proceed without it")
  })

  test("does not contain old user-blame text", () => {
    const err = new Permission.RejectedError()
    expect(err.message).not.toContain("The user rejected")
  })
})

// ── plan and todo nudge text ──────────────────────────────────────

describe("plan and todo nudge text (session/prompt.ts)", () => {
  let promptSrc: string
  test.each([0])("load", async () => {
    promptSrc = await readPrompt("session/prompt.ts")
  })

  test("plan nudge mentions plan_exit", async () => {
    const src = await readPrompt("session/prompt.ts")
    expect(src).toContain("call plan_exit")
  })

  test("autonomous mode plan reminder says cannot ask questions", async () => {
    const src = await readPrompt("session/prompt.ts")
    expect(src).toContain("You cannot ask questions to the user")
  })

  test("todo nudge forbids asking user what to do next", async () => {
    const src = await readPrompt("session/todo.ts")
    expect(src).toContain("Do not ask the user what to do next")
  })

  test("todo nudge says to proceed with next item", async () => {
    const src = await readPrompt("session/todo.ts")
    expect(src).toContain("proceed with the next incomplete item now")
  })

  test("plan nudge says turn ended without completing", async () => {
    const src = await readPrompt("session/prompt.ts")
    expect(src).toContain("Your turn ended without completing the plan")
  })
})
