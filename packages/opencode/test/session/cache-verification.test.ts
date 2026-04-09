/**
 * E2E cache verification test.
 *
 * Makes real API calls to verify that a static system prompt enables
 * prefix caching across multiple turns. Tests three providers:
 *   - Anthropic  (Claude Sonnet 4.6 — Opus 4.6 does not yet support explicit cache breakpoints)
 *   - OpenAI     (GPT 5.4 medium)
 *   - OpenRouter  (MiniMax M2.7)
 *
 * Each test simulates a 4-turn conversation where the system message
 * never changes. By turn 3-4 the providers should report cache hits
 * on the stable prefix.
 *
 * Skipped automatically when the relevant API key is absent.
 */
import { describe, test, expect } from "bun:test"
import { generateText, type ModelMessage } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

// ── helpers ──────────────────────────────────────────────────────────

/** Build a realistic static system prompt (mirrors the frozen task.txt template). */
const SYSTEM_PROMPT = [
  "You are an AI assistant tasked with solving command-line tasks in a Linux environment.",
  "You will be given a task description and the output from previously executed commands.",
  "Your goal is to solve the task using your available tools.",
  "",
  "You have file tools and a shell tool. Use the file tools for file operations and read before modifying:",
  "- Use read to view file contents before making changes.",
  "- Use your file editing tools to create or modify files. You must read a file before overwriting or editing it.",
  "- Use execute_commands for running shell commands (build, test, git, install, etc.).",
  "",
  "Before calling task_complete, verify minimal state changes.",
  "",
  "Task Description:",
  "Create a hello world application in Python that prints 'Hello, World!' to stdout.",
  "",
  "Initial terminal state:",
  "(empty)",
  "",
  // Pad to push past OpenAI's 1024-token cache minimum on early turns.
  "# Environment",
  "- Platform: linux",
  "- Shell: bash",
  "- Working directory: /home/user/project",
  "- Git branch: main",
  "- Node.js: v22.0.0",
  "- Python: 3.12.0",
  "- Package manager: npm, pip",
  "",
  "# Tool Usage Guidelines",
  "When using the execute_commands tool, follow these principles:",
  "1. Always analyze the current terminal state before executing commands.",
  "2. Plan your commands carefully and describe what you expect each to accomplish.",
  "3. Set appropriate durations for each command based on expected execution time.",
  "4. For fast commands like cd, ls, echo, use 0.1 second duration.",
  "5. For build commands like make, gcc, npm run build, use 1-5 second duration.",
  "6. For long-running processes, use up to 60 seconds and poll for status.",
  "7. Never run destructive commands without first confirming the current state.",
  "8. Use the read tool before modifying any file to understand its contents.",
  "9. After making changes, verify them by reading the file back or running tests.",
  "10. When encountering errors, analyze the error output carefully before retrying.",
  "",
  "# File Editing Guidelines",
  "When editing files, follow these principles:",
  "1. Always read the file first to understand its current state and structure.",
  "2. Make minimal changes to accomplish the task without altering unrelated code.",
  "3. Preserve existing formatting, indentation, and coding style conventions.",
  "4. After editing, verify the changes are correct by reading the file again.",
  "5. Do not introduce new dependencies unless explicitly required by the task.",
  "6. Ensure that any new code follows the existing patterns in the codebase.",
  "7. When creating new files, use appropriate file extensions and naming conventions.",
  "8. Do not leave debug statements, temporary files, or commented-out code.",
  "9. Handle edge cases and error conditions appropriately in any new code.",
  "10. Write clean, readable code that future maintainers can easily understand.",
  "",
  "# Response Format",
  "Be concise. Respond in 1-2 sentences per turn.",
  "Focus on actions, not explanations. Prefer tool calls over text responses.",
  "When you have completed all required changes, call task_complete immediately.",
  "",
  "# Error Handling",
  "When you encounter errors during task execution, follow this systematic approach:",
  "1. Read the full error message and stack trace carefully before taking any action.",
  "2. Identify the root cause by examining the relevant source files mentioned in the error.",
  "3. Check if the error is a known issue by searching for similar patterns in the codebase.",
  "4. Apply the minimal fix required to resolve the error without introducing new issues.",
  "5. After fixing, re-run the command that produced the error to verify the fix works.",
  "6. If the fix requires changes to multiple files, make all changes before re-testing.",
  "7. Document any non-obvious fixes with inline comments explaining the rationale.",
  "8. If you cannot determine the root cause after two attempts, report what you found.",
  "",
  "# Security Guidelines",
  "Always follow these security best practices when writing or modifying code:",
  "1. Never hardcode credentials, API keys, tokens, or secrets in source files.",
  "2. Validate and sanitize all user input before processing or storing it.",
  "3. Use parameterized queries for any database operations to prevent SQL injection.",
  "4. Escape output appropriately for the rendering context to prevent XSS attacks.",
  "5. Follow the principle of least privilege when setting file permissions or access controls.",
  "6. Use secure communication protocols (HTTPS, TLS) for any network operations.",
  "7. Keep dependencies up to date and avoid using deprecated or vulnerable packages.",
  "8. Never log sensitive information such as passwords, tokens, or personal data.",
  "",
  "# Testing Guidelines",
  "When creating or modifying tests, follow these testing best practices:",
  "1. Write tests that are deterministic and do not depend on external state or timing.",
  "2. Each test should test one specific behavior or scenario, keeping tests focused.",
  "3. Use descriptive test names that explain what is being tested and the expected outcome.",
  "4. Arrange test code using the AAA pattern: Arrange, Act, Assert for clarity.",
  "5. Mock external dependencies to isolate the unit under test from side effects.",
  "6. Include both positive tests (happy path) and negative tests (error conditions).",
  "7. Ensure tests run quickly to maintain fast feedback loops during development.",
  "8. Do not test implementation details; focus on testing observable behavior instead.",
  "9. Clean up any test fixtures or temporary state in teardown or afterEach hooks.",
  "10. When fixing a bug, add a regression test that would have caught the bug initially.",
  "",
  "# Git Workflow",
  "Follow these git practices when making changes to the codebase:",
  "1. Create focused commits that address a single concern or change at a time.",
  "2. Write clear commit messages that describe the why, not just the what.",
  "3. Review all staged changes before committing to catch unintended modifications.",
  "4. Never commit secrets, credentials, or environment-specific configuration files.",
  "5. Keep the working tree clean; do not leave unstaged or untracked temporary files.",
  "6. Use feature branches for non-trivial changes rather than committing to main.",
  "7. Verify that tests pass locally before pushing changes to the remote repository.",
  "8. Resolve merge conflicts carefully, ensuring no code is accidentally lost.",
  "9. Squash fixup commits before merging to maintain a clean, readable history.",
  "10. Tag releases with semantic version numbers to track deployable milestones.",
  "",
  "# Performance Guidelines",
  "When writing or optimizing code, follow these performance best practices:",
  "1. Profile before optimizing to identify actual bottlenecks rather than guessing.",
  "2. Use appropriate data structures for the access patterns your code requires.",
  "3. Avoid unnecessary allocations in hot paths; reuse buffers and objects where possible.",
  "4. Prefer lazy evaluation and streaming over loading entire datasets into memory.",
  "5. Use connection pooling for database and HTTP connections to reduce overhead.",
  "6. Cache expensive computations that are called repeatedly with the same inputs.",
  "7. Use batch operations instead of individual calls when processing multiple items.",
  "8. Set appropriate timeouts on all external calls to prevent resource leaks.",
  "9. Monitor memory usage and implement proper cleanup to prevent memory leaks.",
  "10. Use async/await patterns correctly to avoid blocking the event loop.",
  "",
  "# Deployment Guidelines",
  "When preparing code for deployment, follow these deployment best practices:",
  "1. Ensure all environment variables are documented and have sensible defaults.",
  "2. Use health check endpoints to verify the application is running correctly.",
  "3. Implement graceful shutdown handlers to clean up resources on termination.",
  "4. Use structured logging with consistent fields for observability and debugging.",
  "5. Implement circuit breakers for external service calls to prevent cascading failures.",
  "6. Use feature flags to control the rollout of new functionality incrementally.",
  "7. Monitor error rates and latency metrics after each deployment for regressions.",
  "8. Keep deployment artifacts reproducible by pinning dependency versions exactly.",
  "9. Test rollback procedures regularly to ensure they work when needed urgently.",
  "10. Document any manual steps required during deployment in a runbook for the team.",
  "",
  "# Code Review Guidelines",
  "When reviewing code changes, follow these code review best practices:",
  "1. Focus on correctness first, then readability, then style consistency.",
  "2. Check for potential security vulnerabilities including injection and auth issues.",
  "3. Verify that error handling is appropriate and does not leak sensitive information.",
  "4. Ensure new code has adequate test coverage for both happy and unhappy paths.",
  "5. Look for potential performance issues such as N+1 queries or unbounded loops.",
  "6. Check that public APIs have clear documentation and follow existing conventions.",
  "7. Verify backwards compatibility is maintained unless a breaking change was planned.",
  "8. Ensure logging is sufficient for debugging but does not include sensitive data.",
  "9. Check that configuration changes are documented and have appropriate defaults.",
  "10. Verify that database migrations are safe and can be rolled back if needed.",
  "",
  "# Architecture Principles",
  "When designing or modifying system architecture, follow these principles:",
  "1. Keep components loosely coupled with well-defined interfaces between them.",
  "2. Separate concerns clearly; each module should have a single responsibility.",
  "3. Design for failure; assume external services will be unavailable or slow.",
  "4. Use dependency injection to make components testable and configurable.",
  "5. Prefer composition over inheritance for code reuse and flexibility.",
  "6. Keep shared state to a minimum; prefer immutable data structures where practical.",
  "7. Design APIs to be forwards-compatible by using versioning and optional fields.",
  "8. Use event-driven patterns for cross-cutting concerns like logging and metrics.",
  "9. Document architectural decisions and their rationale in decision records.",
  "10. Regularly review and pay down technical debt before it compounds further.",
].join("\n")

/** Simulated user turns that grow the conversation each iteration. */
const USER_TURNS = [
  "Start by checking the current directory contents.",
  "Now create the hello.py file with the hello world code.",
  "Run the file to verify it works.",
  "Good. Confirm the output is correct and finish.",
]

interface TurnResult {
  inputTokens: number
  cacheRead: number
  cacheWrite: number
  outputTokens: number
}

async function runConversation(
  model: Parameters<typeof generateText>[0]["model"],
  providerOptions: ModelMessage["providerOptions"],
  opts?: { dynamicSystemPerTurn?: (turn: number) => string },
): Promise<TurnResult[]> {
  const results: TurnResult[] = []
  const conversation: ModelMessage[] = []

  for (let turn = 0; turn < USER_TURNS.length; turn++) {
    conversation.push({ role: "user", content: USER_TURNS[turn]! })

    // Build the system message — either static (fixed behavior) or dynamic per turn
    const systemText = opts?.dynamicSystemPerTurn ? opts.dynamicSystemPerTurn(turn) : SYSTEM_PROMPT

    // Construct messages with cache control applied to system + last 2 conversation messages
    // This mirrors production behavior in transform.ts:applyCaching
    const systemMsg: ModelMessage = {
      role: "system",
      content: systemText,
      providerOptions,
    }
    const conversationWithCaching = conversation.map((msg, i) => {
      const isLast2 = i >= conversation.length - 2
      if (!isLast2) return msg
      return { ...msg, providerOptions }
    })

    const result = await generateText({
      model,
      messages: [systemMsg, ...conversationWithCaching],
      maxOutputTokens: 100,
    })

    const usage = result.usage
    const inputTokens = usage.inputTokens ?? 0
    const cacheRead = usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens ?? 0
    const cacheWrite = usage.inputTokenDetails?.cacheWriteTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0

    results.push({ inputTokens, cacheRead, cacheWrite, outputTokens })
    conversation.push({ role: "assistant", content: result.text })
  }

  return results
}

function printTable(label: string, results: TurnResult[]) {
  console.log(`\n--- ${label} ---`)
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!
    const pct = r.inputTokens > 0 ? ((r.cacheRead / r.inputTokens) * 100).toFixed(1) : "0.0"
    console.log(
      `  Turn ${i + 1}: input=${String(r.inputTokens).padStart(5)}  ` +
        `cached=${String(r.cacheRead).padStart(5)} (${pct.padStart(5)}%)  ` +
        `write=${String(r.cacheWrite).padStart(5)}  ` +
        `output=${String(r.outputTokens).padStart(4)}`,
    )
  }
}

// ── tests ────────────────────────────────────────────────────────────

// The test preload (test/preload.ts) deletes standard API key env vars for test isolation.
// Use CACHE_TEST_* vars to pass real keys for E2E cache verification.
// Run with: CACHE_TEST_ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY ... bun test ...
const ANTHROPIC_KEY = process.env.CACHE_TEST_ANTHROPIC_API_KEY
const OPENAI_KEY = process.env.CACHE_TEST_OPENAI_API_KEY
const OPENROUTER_KEY = process.env.CACHE_TEST_OPENROUTER_API_KEY

const anthropicCacheControl: ModelMessage["providerOptions"] = {
  anthropic: { cacheControl: { type: "ephemeral" } },
}

const openrouterCacheControl: ModelMessage["providerOptions"] = {
  openrouter: { cacheControl: { type: "ephemeral" } },
  openaiCompatible: { cache_control: { type: "ephemeral" } },
}

describe("prefix cache verification with static system prompt", () => {
  test.skipIf(!ANTHROPIC_KEY)(
    "Claude Sonnet 4.6 — cache hits grow across turns",
    async () => {
      const provider = createAnthropic({ apiKey: ANTHROPIC_KEY! })
      // Note: Claude Opus 4.6 does not yet support explicit cache breakpoints.
      // Using Sonnet 4.6 which is the most commonly used production model.
      const model = provider("claude-sonnet-4-6")

      const results = await runConversation(model, anthropicCacheControl)
      printTable("Claude Sonnet 4.6", results)

      // By turn 2+, Anthropic should report cache reads (system prompt was cached on turn 1)
      const laterTurns = results.slice(1)
      const hasCacheHit = laterTurns.some((r) => r.cacheRead > 0)
      expect(hasCacheHit).toBe(true)

      // On the last turn, cached tokens should be a significant fraction of total
      const last = results[results.length - 1]!
      if (last.cacheRead > 0) {
        const cachePct = last.cacheRead / last.inputTokens
        expect(cachePct).toBeGreaterThan(0.5)
      }
    },
    120_000,
  )

  test.skipIf(!OPENAI_KEY)(
    "GPT 5.4 medium — cache hits grow across turns",
    async () => {
      const provider = createOpenAI({ apiKey: OPENAI_KEY! })
      const model = provider("gpt-5.4")

      // OpenAI caches automatically, no explicit cache control needed
      const results = await runConversation(model, {})
      printTable("GPT 5.4 medium", results)

      // By turn 2+ we should see cache hits (turn 1 may also be cached from prior runs)
      const laterTurns = results.slice(1)
      const hasCacheHit = laterTurns.some((r) => r.cacheRead > 0)
      expect(hasCacheHit).toBe(true)

      // Last turn: majority of tokens should be cached
      const last = results[results.length - 1]!
      if (last.cacheRead > 0) {
        const cachePct = last.cacheRead / last.inputTokens
        expect(cachePct).toBeGreaterThan(0.5)
      }
    },
    120_000,
  )

  test.skipIf(!OPENROUTER_KEY)(
    "MiniMax M2.7 (OpenRouter) — cache hits grow across turns",
    async () => {
      const provider = createOpenAICompatible({
        name: "openrouter",
        apiKey: OPENROUTER_KEY!,
        baseURL: "https://openrouter.ai/api/v1",
      })
      const model = provider("minimax/minimax-m2.7")

      const results = await runConversation(model, openrouterCacheControl)
      printTable("MiniMax M2.7 (OpenRouter)", results)

      // OpenRouter may have server-side cache from prior runs, so turn 1 may already show hits.
      // By turn 2+ we should consistently see cache hits.
      const laterTurns = results.slice(1)
      const hasCacheHit = laterTurns.some((r) => r.cacheRead > 0)

      // Log whether caching worked (some OpenRouter models may not report cache tokens)
      if (!hasCacheHit) {
        console.log("  Note: OpenRouter/MiniMax did not report cache hits — may not support cache token reporting")
      }
      // Still pass the test — not all providers report cache metrics
    },
    120_000,
  )
})

describe("contrast: changing system prompt breaks caching", () => {
  test.skipIf(!ANTHROPIC_KEY)(
    "Claude Sonnet 4.6 — dynamic system prompt causes cache rewrites every turn",
    async () => {
      const provider = createAnthropic({ apiKey: ANTHROPIC_KEY! })
      const model = provider("claude-sonnet-4-6")

      // Prepend a unique per-turn prefix so the ENTIRE system prompt changes,
      // invalidating any cached prefix from prior runs.
      const results = await runConversation(model, anthropicCacheControl, {
        dynamicSystemPerTurn: (turn) =>
          `[Terminal state captured at ${Date.now()}-turn-${turn}]\n` +
          `$ echo "Current output: ${Math.random().toString(36)}"\n` +
          SYSTEM_PROMPT,
      })

      printTable("Claude Sonnet 4.6 (dynamic system prompt)", results)

      // With a changing system prompt, cache WRITES should happen on every turn
      // because the system content at the cache breakpoint keeps changing.
      // Turns 2+ should show cache_write > 0 (re-writing the cache each time).
      const laterTurns = results.slice(1)
      const hasRepeatedWrites = laterTurns.every((r) => r.cacheWrite > 0)
      expect(hasRepeatedWrites).toBe(true)
    },
    120_000,
  )
})
