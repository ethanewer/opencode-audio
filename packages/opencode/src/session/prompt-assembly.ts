export function assemblePrompt(plan: string, findings: string[]): string {
  const parts: string[] = []

  parts.push("## Approved Plan\n")
  parts.push(plan)

  if (findings.length) {
    parts.push("\n\n## Research Context\n")
    parts.push("The following context was gathered by parallel research subagents:\n")
    for (let i = 0; i < findings.length; i++) {
      const trimmed = findings[i].length > 2000 ? findings[i].slice(0, 2000) + "\n... (truncated)" : findings[i]
      parts.push(`### Finding ${i + 1}\n\n${trimmed}\n`)
    }
    parts.push("Use this context to inform your implementation. Do not repeat the research.\n")
  }

  parts.push("\n## Pre-Commit Verification\n")
  parts.push("Before committing, verify:\n")
  parts.push("1. Build passes\n")
  parts.push("2. Any new config/struct fields are wired through\n")
  parts.push("3. Any new method calls have implementations\n")
  parts.push("4. Tests pass and new code is tested\n")
  parts.push("5. Lint compliance\n")
  parts.push("\nIf any verification fails, fix it before committing.\n")

  return parts.join("")
}
