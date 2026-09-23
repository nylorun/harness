import type {
  CapabilityDeclaration,
  McpServerManifest,
} from "@nylorun/core/define";

export interface McpOptions {
  /** Capability id. Defaults to `"mcp"`. */
  readonly id?: string;
}

export interface McpCapability extends CapabilityDeclaration {
  readonly mcpServers: Readonly<Record<string, McpServerManifest>>;
}

export class McpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "McpError";
    this.code = code;
  }
}

/**
 * Declare MCP servers as one capability for `Agent.use`.
 *
 * The map shape matches agent-plugins `mcpServers` and manifest v3: each key
 * must equal that server's `name`. Supported transports are `stdio`,
 * `streamable-http`, and `sse` (see https://agent-plugins.org/plugin-authors/mcp-servers).
 *
 * ```ts
 * Agent({...}).use(mcp({
 *   github: {
 *     name: "github",
 *     type: "streamable-http",
 *     url: "https://mcp.example.com/github",
 *   },
 * }))
 * ```
 */
export function mcp(
  servers: Readonly<Record<string, McpServerManifest>>,
  options: McpOptions = {}
): McpCapability {
  const id = options.id ?? "mcp";
  if (!isRecord(servers)) {
    throw new McpError(
      "mcp.invalid",
      "mcp() expects a non-empty map of MCP servers"
    );
  }
  const entries = Object.entries(servers);
  if (entries.length === 0) {
    throw new McpError(
      "mcp.empty",
      "mcp() requires at least one MCP server"
    );
  }
  const mcpServers: Record<string, McpServerManifest> = {};
  for (const [key, server] of entries) {
    if (!isMcpServer(server)) {
      throw new McpError(
        "mcp.invalid-server",
        `MCP server '${key}' is not a valid stdio, streamable-http, or sse declaration`
      );
    }
    if (server.name !== key) {
      throw new McpError(
        "mcp.name-mismatch",
        `MCP server key '${key}' must equal the server name '${server.name}'`
      );
    }
    mcpServers[key] = freezeServer(server);
  }
  return { id, mcpServers: Object.freeze(mcpServers) };
}

function freezeServer(server: McpServerManifest): McpServerManifest {
  if (server.type === "stdio") {
    return Object.freeze({
      name: server.name,
      type: "stdio" as const,
      command: server.command,
      ...(server.args === undefined ? {} : { args: Object.freeze([...server.args]) }),
      ...(server.env === undefined
        ? {}
        : { env: Object.freeze({ ...server.env }) }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
    });
  }
  return Object.freeze({
    name: server.name,
    type: server.type,
    url: server.url,
    ...(server.headers === undefined
      ? {}
      : { headers: Object.freeze({ ...server.headers }) }),
  });
}

function isMcpServer(value: unknown): value is McpServerManifest {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name)
    return false;
  if (value.type === "stdio")
    return typeof value.command === "string" && value.command.length > 0;
  if (value.type === "streamable-http" || value.type === "sse")
    return typeof value.url === "string" && value.url.length > 0;
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
