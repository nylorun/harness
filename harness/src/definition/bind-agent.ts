import type { AgentManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "./bound.js";
import type { BuiltAgent } from "../types/agent.js";
import type { ToolSchemaSource } from "../types/tool.js";
import { bindOutputContract } from "./output-contract.js";
import { registerDefinition, type AgentDefinition } from "./agent-definition.js";
import type { CapabilityDynamics } from "./assemble.js";
import type { Implementations } from "./implementations.js";
import { ToolRegistry } from "./registry.js";
import { hashManifest } from "../utils/hash.js";

export function bindAgent(
  middleware: readonly BoundMiddleware[],
  manifest: AgentManifest,
  options: { outputSchema?: ToolSchemaSource } = {},
  dynamics: ReadonlyMap<string, CapabilityDynamics> = new Map(),
): BuiltAgent {
  const implementations = buildImplementations(middleware, dynamics);
  const definition: AgentDefinition = Object.freeze({
    id: manifest.id,
    middleware,
    registry: new ToolRegistry(middleware),
    ...(options.outputSchema === undefined
      ? {}
      : { output: bindOutputContract(options.outputSchema) }),
    manifest,
    hash: hashManifest(manifest),
    implementations,
  });
  const agent: BuiltAgent = {
    id: definition.id,
    name: manifest.name,
    manifest,
    hash: definition.hash,
    toJSON: () => manifest,
  };
  registerDefinition(agent, definition);
  return agent;
}

function buildImplementations(
  middleware: readonly BoundMiddleware[],
  dynamics: ReadonlyMap<string, CapabilityDynamics>,
): Implementations {
  const table: Record<string, Implementations[string]> = {};
  for (const item of middleware) {
    const tools: Record<string, NonNullable<BoundMiddleware["tools"]>[number]> = {};
    for (const tool of item.tools ?? []) tools[tool.name] = tool;
    const dyn = dynamics.get(item.id);
    table[item.id] = Object.freeze({
      ...(Object.keys(tools).length ? { tools: Object.freeze({ ...tools }) } : {}),
      ...(dyn?.beforeModelCall ? { beforeModelCall: dyn.beforeModelCall } : {}),
      ...(dyn?.afterModelCall ? { afterModelCall: dyn.afterModelCall } : {}),
      ...(dyn?.middleware ? { middleware: dyn.middleware } : {}),
    });
  }
  return Object.freeze(table);
}
