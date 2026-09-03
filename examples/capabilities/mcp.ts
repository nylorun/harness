import { tool } from "@nylorun/harness";
import { z } from "zod";
import type { LocalMcp } from "../services/mcp.js";

export function mcpTools(mcp: LocalMcp) {
  return {
    id: "mcp-tools",
    instructions: ["mcp_add is supplied by a local stdio MCP server."],
    tools: [
      tool({
        name: "mcp_add",
        description: "Add integers through the local MCP demonstration server.",
        inputSchema: z.object({ left: z.number().int(), right: z.number().int() }),
        async execute({ left, right }) {
          try {
            return { kind: "completed" as const, output: (await mcp.add(left, right)) as never };
          } catch (error) {
            return {
              kind: "failed" as const,
              code: "mcp.unavailable",
              message: error instanceof Error ? error.message : "MCP server unavailable.",
            };
          }
        },
      }),
    ],
  } as const;
}
