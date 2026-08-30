import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "nylorun-harness-examples-mcp", version: "0.1.0" });
server.registerTool(
  "mcp_add",
  {
    description: "Add two integers through the local MCP demo server.",
    inputSchema: { left: z.number().int(), right: z.number().int() },
  },
  async ({ left, right }) => ({
    content: [{ type: "text", text: String(left + right) }],
    structuredContent: { left, right, sum: left + right },
  }),
);
await server.connect(new StdioServerTransport());
