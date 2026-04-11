export type Complexity = "simple" | "complex"

const simple = [
  "fix typo",
  "typo",
  "add log",
  "add logging",
  "update comment",
  "fix comment",
  "rename variable",
  "rename function",
  "rename",
  "remove unused",
  "delete unused",
  "bump version",
  "update version",
  "fix import",
  "add import",
  "fix whitespace",
  "formatting",
  "lint fix",
  "add field",
  "add property",
  "add parameter",
  "add argument",
  "small fix",
  "minor fix",
  "quick fix",
  "update config",
  "change config",
  "update constant",
  "add constant",
  "add test case",
  "fix test",
]

const complex = [
  "refactor",
  "rewrite",
  "redesign",
  "migrate",
  "migration",
  "architecture",
  "restructure",
  "overhaul",
  "database schema",
  "api design",
  "multi-file",
  "cross-cutting",
]

export function detectComplexity(text: string): Complexity {
  const lower = text.toLowerCase()

  for (const pattern of complex) {
    if (lower.includes(pattern)) return "complex"
  }

  for (const pattern of simple) {
    if (lower.includes(pattern)) return "simple"
  }

  const words = lower.split(/\s+/).length
  if (words < 150) return "simple"
  return "complex"
}
