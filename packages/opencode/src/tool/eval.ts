import z from "zod"
import { Tool } from "./tool"

import DESCRIPTION from "./eval.txt"

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
