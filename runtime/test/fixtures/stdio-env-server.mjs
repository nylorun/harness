#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "local", version: "0.0.0" });
server.registerTool(
  "env",
  {
    description: "Report one environment variable.",
    inputSchema: { key: z.string() },
  },
  async ({ key }) => ({
    content: [{ type: "text", text: process.env[key] ?? "" }],
    structuredContent: {
      value: process.env[key] ?? null,
      pluginData: process.env.PLUGIN_DATA ?? null,
      leaked: process.env.NYLORUN_PARENT_SECRET ?? null,
    },
  }),
);
await server.connect(new StdioServerTransport());
