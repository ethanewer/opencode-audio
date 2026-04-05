import { describe, expect, test } from "bun:test"
import type { Part, Session, SessionStatus, UserMessage } from "@opencode-ai/sdk/v2"
import { resolve } from "../../../src/cli/cmd/tui/component/prompt/auto-restore"

function msg(agent = "plan") {
  return {
    id: "msg_1",
    sessionID: "ses_1",
    role: "user",
    time: { created: 1 },
    agent,
    model: { providerID: "openai", modelID: "gpt-5.4" },
  } as UserMessage
}

function session(input?: Partial<Session>) {
  return {
    id: "ses_1",
    slug: "ses_1",
    projectID: "project_1",
    directory: "/tmp/project",
    title: "Test",
    version: "1",
    time: { created: 1, updated: 1 },
    permission: input?.permission,
    parentID: input?.parentID,
  } as Session
}

function auto() {
  return [
    { permission: "question", action: "deny", pattern: "*" },
    { permission: "plan_enter", action: "deny", pattern: "*" },
    { permission: "plan_exit", action: "deny", pattern: "*" },
    { permission: "tui_auto", action: "deny", pattern: "*" },
  ] as Session["permission"]
}

function denied() {
  return [{ permission: "plan_exit", action: "deny", pattern: "*" }] as Session["permission"]
}

function handoff() {
  return [
    {
      id: "part_1",
      sessionID: "ses_1",
      messageID: "msg_2",
      type: "text",
      text: "handoff",
      metadata: { plan: { handoff: true } },
    } satisfies Part,
  ]
}

describe("auto restore", () => {
  test("restores auto plan for active auto root sessions", () => {
    expect(
      resolve({
        msg: msg("plan"),
        parts: [],
        session: session({ permission: auto() }),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "auto", phase: "plan" })
  })

  test("restores auto build for active auto root sessions", () => {
    expect(
      resolve({
        msg: msg("build"),
        parts: [],
        session: session({ permission: auto() }),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "auto", phase: "build" })
  })

  test("restores auto idle for idle auto root sessions", () => {
    expect(
      resolve({
        msg: msg("build"),
        parts: [],
        session: session({ permission: auto() }),
        status: { type: "idle" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "auto", phase: "idle" })
  })

  test("restores auto build from handoff metadata", () => {
    expect(
      resolve({
        msg: msg("plan"),
        parts: handoff(),
        session: session({ permission: auto() }),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "auto", phase: "build" })
  })

  test("keeps explicit plan sessions in plan", () => {
    expect(
      resolve({
        msg: msg("plan"),
        parts: [],
        session: session(),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "plan" })
  })

  test("does not treat root sessions with only plan_exit denied as auto", () => {
    expect(
      resolve({
        msg: msg("plan"),
        parts: [],
        session: session({ permission: denied() }),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "plan" })
  })

  test("does not treat child sessions as auto", () => {
    expect(
      resolve({
        msg: msg("plan"),
        parts: [],
        session: session({ permission: auto(), parentID: "ses_parent" }),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "plan" })
  })

  test("treats non-plan/non-build agents as build phase in auto mode", () => {
    // During eval subtask or other agents, phase should be "build" not "plan"
    expect(
      resolve({
        msg: msg("eval"),
        parts: [],
        session: session({ permission: auto() }),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "auto", phase: "build" })

    expect(
      resolve({
        msg: msg("general"),
        parts: [],
        session: session({ permission: auto() }),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "auto", phase: "build" })
  })

  test("maps voice agents back to auto phases", () => {
    expect(
      resolve({
        msg: msg("voice-plan"),
        parts: [],
        session: session({ permission: auto() }),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "auto", phase: "plan" })

    expect(
      resolve({
        msg: msg("voice-build"),
        parts: [],
        session: session({ permission: auto() }),
        status: { type: "busy" } satisfies SessionStatus,
      }),
    ).toEqual({ agent: "auto", phase: "build" })
  })
})
