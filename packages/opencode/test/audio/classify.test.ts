import { describe, test, expect, mock } from "bun:test"

let lastCall: { system: string; prompt: string; schema: unknown } | undefined
let mockReturn = { option: null as string | null, confidence: "0" }

mock.module("ai", () => ({
  generateObject: async (opts: { system: string; prompt: string; schema: unknown }) => {
    lastCall = opts
    return { object: { ...mockReturn } }
  },
}))

const { classify } = await import("../../src/audio/classify")

const fakeModel = {} as Parameters<typeof classify>[0]

describe("classify", () => {
  const options = ["Option A", "Option B", "Option C"]

  test("returns matched option with confidence", async () => {
    mockReturn = { option: "Option A", confidence: "1" }
    const result = await classify(fakeModel, "I want option A", options)
    expect(result.option).toBe("Option A")
    expect(result.confidence).toBe(1)
  })

  test("returns null option when model returns null", async () => {
    mockReturn = { option: null, confidence: "0" }
    const result = await classify(fakeModel, "gibberish", options)
    expect(result.option).toBeNull()
    expect(result.confidence).toBe(0)
  })

  test("returns null when model returns option not in list", async () => {
    mockReturn = { option: "Option D", confidence: "1" }
    const result = await classify(fakeModel, "option D", options)
    expect(result.option).toBeNull()
    expect(result.confidence).toBe(1)
  })

  test("parses confidence values correctly", async () => {
    for (const val of ["0", "0.25", "0.5", "0.75", "1"] as const) {
      mockReturn = { option: "Option A", confidence: val }
      const result = await classify(fakeModel, "test", options)
      expect(result.confidence).toBe(parseFloat(val))
    }
  })

  test("passes question to prompt when provided", async () => {
    mockReturn = { option: "Option A", confidence: "1" }
    await classify(fakeModel, "the first one", options, "Which option?")
    expect(lastCall!.prompt).toContain("Which option?")
    expect(lastCall!.prompt).toContain("the first one")
  })

  test("omits question from prompt when not provided", async () => {
    mockReturn = { option: "Option A", confidence: "1" }
    await classify(fakeModel, "the first one", options)
    expect(lastCall!.prompt).not.toContain("Question:")
    expect(lastCall!.prompt).toContain("the first one")
  })

  test("includes all options in prompt", async () => {
    mockReturn = { option: null, confidence: "0" }
    await classify(fakeModel, "test", options)
    expect(lastCall!.prompt).toContain("Option A")
    expect(lastCall!.prompt).toContain("Option B")
    expect(lastCall!.prompt).toContain("Option C")
  })

  test("includes transcript in prompt", async () => {
    mockReturn = { option: null, confidence: "0" }
    await classify(fakeModel, "I want the second one", options)
    expect(lastCall!.prompt).toContain("I want the second one")
  })

  test("handles single option", async () => {
    mockReturn = { option: "Only", confidence: "1" }
    const result = await classify(fakeModel, "that one", ["Only"])
    expect(result.option).toBe("Only")
    expect(result.confidence).toBe(1)
  })

  test("handles many options", async () => {
    const many = Array.from({ length: 20 }, (_, i) => `Item ${i + 1}`)
    mockReturn = { option: "Item 15", confidence: "0.75" }
    const result = await classify(fakeModel, "fifteen", many)
    expect(result.option).toBe("Item 15")
    expect(result.confidence).toBe(0.75)
  })

  test("partial confidence triggers confirmation range", async () => {
    mockReturn = { option: "Option B", confidence: "0.5" }
    const result = await classify(fakeModel, "maybe B", options)
    expect(result.option).toBe("Option B")
    expect(result.confidence).toBeGreaterThan(0)
    expect(result.confidence).toBeLessThan(1)
  })

  test("zero confidence with valid option", async () => {
    mockReturn = { option: "Option A", confidence: "0" }
    const result = await classify(fakeModel, "something", options)
    expect(result.option).toBe("Option A")
    expect(result.confidence).toBe(0)
  })

  test("empty string option from model treated as null", async () => {
    mockReturn = { option: "", confidence: "0.5" }
    const result = await classify(fakeModel, "test", options)
    expect(result.option).toBeNull()
  })

  test("system prompt contains classification instructions", async () => {
    mockReturn = { option: null, confidence: "0" }
    await classify(fakeModel, "test", options)
    expect(lastCall!.system).toContain("classifying")
    expect(lastCall!.system).toContain("voice transcript")
  })

  test("handles empty options array", async () => {
    mockReturn = { option: "anything", confidence: "1" }
    const result = await classify(fakeModel, "test", [])
    expect(result.option).toBeNull()
  })

  test("handles whitespace-only transcript", async () => {
    mockReturn = { option: "Option A", confidence: "0.75" }
    const result = await classify(fakeModel, "   ", options)
    expect(lastCall!.prompt).toContain("   ")
    expect(result.option).toBe("Option A")
  })

  test("handles option with special characters", async () => {
    const special = ["Yes, proceed", "No (cancel)", "Maybe / later"]
    mockReturn = { option: "Yes, proceed", confidence: "1" }
    const result = await classify(fakeModel, "go ahead", special)
    expect(result.option).toBe("Yes, proceed")
  })
})
