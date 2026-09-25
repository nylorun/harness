#!/usr/bin/env node
/**
 * Stdio MCP fixture for WS-G hostile-environment checks.
 * Reports selected env keys without depending on Host ambient.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const KEYS = [
  "HOME",
  "TMPDIR",
  "PATH",
  "NYLORUN_VAULT_KEK",
  "MODEL_PROVIDER_API_KEY",
  "OPENAI_API_KEY",
  "NYLORUN_SANDBOX",
  "NODE_OPTIONS",
  "AWS_ACCESS_KEY_ID",
  "NYLORUN_PARENT_SECRET",
];

const server = new McpServer({ name: "env-dump", version: "0.0.0" });
server.registerTool(
  "dump",
  {
    description: "Report selected environment variables.",
    inputSchema: { unused: z.string().optional() },
  },
  async () => {
    const env = Object.fromEntries(
      KEYS.map((key) => [key, process.env[key] ?? null]),
    );
    return {
      content: [{ type: "text", text: JSON.stringify(env) }],
      structuredContent: env,
    };
  },
);
await server.connect(new StdioServerTransport());
