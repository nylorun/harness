import { Agent as HarnessAgent } from "@nylorun/harness";
import type {
  AgentConfig,
  AgentSpec as AgentSpecRecord,
  AgentSpecOptions,
  HarnessFactory,
  McpDeclaration,
  RunOptions,
} from "./types.js";

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

export function Run(harness: HarnessFactory, options: RunOptions): AgentSpec {
  if (typeof harness !== "function") throw new TypeError("Harness factory must be a function");
  if (!isModelIdentity(options.model)) throw new TypeError(`Invalid model identity: ${options.model}`);
  if (options.name !== undefined && !isPortableName(options.name)) throw new TypeError(`Invalid agent name: ${options.name}`);
  const secrets = Object.freeze([...(options.secrets ?? [])]);
  if (new Set(secrets).size !== secrets.length) throw new TypeError("Secret names must be unique");
  const mcp = Object.freeze((options.mcp ?? []).map(normalizeMcp));
  if (new Set(mcp.map((entry) => entry.name)).size !== mcp.length) throw new TypeError("MCP names must be unique");
  return Object.freeze({
    ...(options.name === undefined ? {} : { name: options.name }),
    model: options.model,
    harness,
    secrets,
    mcp
  });
}

export type AgentSpec = AgentSpecRecord;

export function AgentSpec(options: AgentSpecOptions): AgentSpec {
  return Object.freeze({
    ...Run((model, directive) => HarnessAgent(model, directive), options),
    ...(options.instructions === undefined ? {} : { instructions: options.instructions })
  });
}

/** @deprecated One-release compatibility alias; generated projects pass a Harness factory to Run. */
export function Agent(options: AgentSpecOptions): AgentSpec {
  return AgentSpec(options);
}
