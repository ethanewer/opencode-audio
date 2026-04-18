import { describe, expect, test } from "bun:test"
import path from "path"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import type { Provider } from "../../src/provider/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SessionID } from "../../src/session/schema"
import { SystemPrompt } from "../../src/session/system"
import { tmpdir } from "../fixture/fixture"

const fakeModel: Provider.Model = {
  id: ModelID.make("m"),
  providerID: ProviderID.make("p"),
  api: { id: "m", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "m",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, output: 0 },
  status: "active",
  options: {},
  headers: {},
  release_date: "",
} as unknown as Provider.Model

describe("session.system", () => {
  test("environment block contains platform, directory, and date", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const [block] = await SystemPrompt.environment({
          model: fakeModel,
          sessionID: SessionID.make("test"),
        })
        expect(block).toContain("<env>")
        expect(block).toContain("</env>")
        expect(block).toContain(`Working directory: ${tmp.path}`)
        expect(block).toContain(`Platform: ${process.platform}`)
        expect(block).toContain("Is directory a git repo: yes")
        expect(block).toContain("Today's date:")
      },
    })
  })

  test("environment block reports available languages and package managers", async () => {
    // Non-exhaustive: we only assert on the Languages/Package managers lines
    // when at least one known tool is found. On fully-stripped containers
    // (no node/python/etc. installed) these sections may legitimately be
    // absent. The snapshot filters out "not found" entries.
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const [block] = await SystemPrompt.environment({
          model: fakeModel,
          sessionID: SessionID.make("test"),
        })
        // The process running these tests has bun (bun:test is running),
        // so bun must appear somewhere in the env block.
        expect(block).toContain("bun ")
      },
    })
  })

  test("environment block is stable across calls in the same process", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const [a] = await SystemPrompt.environment({
          model: fakeModel,
          sessionID: SessionID.make("test"),
        })
        const [b] = await SystemPrompt.environment({
          model: fakeModel,
          sessionID: SessionID.make("test"),
        })
        // Date might roll over during the test, so strip that line.
        const strip = (s: string) => s.replace(/  Today's date:.*\n/, "")
        expect(strip(a)).toBe(strip(b))
      },
    })
  })

  test("skills output is sorted by name and stable across calls", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        for (const [name, description] of [
          ["zeta-skill", "Zeta skill."],
          ["alpha-skill", "Alpha skill."],
          ["middle-skill", "Middle skill."],
        ]) {
          const skillDir = path.join(dir, ".opencode", "skill", name)
          await Bun.write(
            path.join(skillDir, "SKILL.md"),
            `---
name: ${name}
description: ${description}
---

# ${name}
`,
          )
        }
      },
    })

    const home = process.env.OPENCODE_TEST_HOME
    process.env.OPENCODE_TEST_HOME = tmp.path

    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const build = await Agent.get("build")
          const first = await SystemPrompt.skills(build!)
          const second = await SystemPrompt.skills(build!)

          expect(first).toBe(second)

          const alpha = first!.indexOf("<name>alpha-skill</name>")
          const middle = first!.indexOf("<name>middle-skill</name>")
          const zeta = first!.indexOf("<name>zeta-skill</name>")

          expect(alpha).toBeGreaterThan(-1)
          expect(middle).toBeGreaterThan(alpha)
          expect(zeta).toBeGreaterThan(middle)
        },
      })
    } finally {
      process.env.OPENCODE_TEST_HOME = home
    }
  })
})
