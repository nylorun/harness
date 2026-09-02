import { tool } from "@nylorun/harness";
import { z } from "zod";

export const tools = [
  tool({
    name: "calculate",
    description: "Evaluate basic arithmetic using numbers, parentheses, and + - * /.",
    parameters: z.object({ expression: z.string().min(1).max(100) }),
    async execute({ expression }) {
      if (!/^[0-9+\-*/().\s]+$/u.test(expression)) {
        return {
          kind: "failed" as const,
          code: "unsupported_expression",
          message: "Only basic arithmetic is supported.",
        };
      }
      try {
        const value = Function(`\"use strict\"; return (${expression})`)();
        return typeof value === "number" && Number.isFinite(value)
          ? { kind: "completed" as const, output: { expression, value } }
          : {
              kind: "failed" as const,
              code: "invalid_expression",
              message: "Expression is not finite.",
            };
      } catch {
        return {
          kind: "failed" as const,
          code: "invalid_expression",
          message: "Expression could not be evaluated.",
        };
      }
    },
  }),
];
