import type { AgentConfig, AgentOptions, McpDeclaration } from "./types.js";

const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const MODEL = /^[a-z0-9][a-z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

export function isPortableName(value: string): boolean {
  return NAME.test(value);
}

export function isModelIdentity(value: string): boolean {
  return MODEL.test(value);
}

function normalizeMcp(value: McpDeclaration): AgentConfig["mcp"][number] {
  if (!isPortableName(value.name)) throw new TypeError(`Invalid MCP name: ${value.name}`);
  const url = new URL(value.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new TypeError(`Invalid MCP URL protocol: ${url.protocol}`);
  return Object.freeze({
    name: value.name,
    url: value.url,
    transport: value.transport ?? "streamable-http",
    ...(value.secret ? { secret: value.secret } : {})
  });
}

export function Agent(options: AgentOptions): AgentConfig {
  if (!isPortableName(options.name)) throw new TypeError(`Invalid agent name: ${options.name}`);
  if (!isModelIdentity(options.model)) throw new TypeError(`Invalid model identity: ${options.model}`);
  const secrets = Object.freeze([...(options.secrets ?? [])]);
  if (new Set(secrets).size !== secrets.length) throw new TypeError("Secret names must be unique");
  const mcp = Object.freeze((options.mcp ?? []).map(normalizeMcp));
  if (new Set(mcp.map((entry) => entry.name)).size !== mcp.length) throw new TypeError("MCP names must be unique");
  return Object.freeze({
    name: options.name,
    model: options.model,
    ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
    secrets,
    mcp
  });
}
