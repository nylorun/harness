import { tool } from "@nylorun/harness";
import { z } from "zod";

export const tools = [
  tool({
    name: "now",
    description: "Return the current UTC time. Use when the user asks what time it is.",
    parameters: z.object({}),
    async execute() {
      const instant = new Date();
      return {
        kind: "completed" as const,
        output: { iso: instant.toISOString(), unixMs: instant.getTime() },
      };
    },
  }),
];
