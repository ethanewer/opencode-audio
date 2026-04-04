import z from "zod"
import { Tool } from "./tool"

import DESCRIPTION from "./eval.txt"

const REBUT = [
  "Submit a rebuttal to the most recent failed evaluation.",
  "",
  "Use this only when you believe the evaluator is mistaken or when you need to defend a design choice with specific evidence.",
  "If you do not need to rebut, continue normally and fix the work instead.",
].join("\n")

export const EvalTool = Tool.define("eval_result", {
  description: DESCRIPTION,
  parameters: z.object({
    pass: z
      .boolean()
      .describe("Whether the work passes evaluation — true if correct and complete, false if issues found"),
    summary: z.string().describe("Brief summary of the evaluation findings"),
    issues: z
      .array(
        z.object({
          file: z.string().optional().describe("File path where the issue was found"),
          description: z.string().describe("Description of the issue"),
          severity: z.enum(["error", "warning"]).describe("Severity: error for must-fix, warning for should-fix"),
        }),
      )
      .optional()
      .describe("Specific issues found during evaluation"),
  }),
  async execute(args) {
    return {
      title: args.pass ? "Evaluation: PASS" : "Evaluation: FAIL",
      output: JSON.stringify(args),
      metadata: {
        pass: args.pass,
        summary: args.summary,
        issues: args.issues,
      },
    }
  },
})

export const EvalRebuttalTool = Tool.define("eval_rebuttal", {
  description: REBUT,
  parameters: z.object({
    content: z.string().describe("The rebuttal to send back to the evaluator"),
  }),
  async execute(args) {
    return {
      title: "Evaluation Rebuttal",
      output: args.content,
      metadata: {
        content: args.content,
      },
    }
  },
})
