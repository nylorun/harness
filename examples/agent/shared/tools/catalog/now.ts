import { tool } from "@nylorun/harness";
import { z } from "zod";

export const tools = [
  tool({
    name: "now",
    description:
      "Return the current UTC time as an object { iso: string, unixMs: number }. Use its iso field for an ISO timestamp. Use when the user asks what time it is.",
    inputSchema: z.object({}),
    async execute() {
      const instant = new Date();
      return {
        kind: "completed" as const,
        output: { iso: instant.toISOString(), unixMs: instant.getTime() },
      };
    },
  }),
];
