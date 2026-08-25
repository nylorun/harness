import { createHash } from "node:crypto";
import type { Capability, CapabilityManifest } from "../types/capability.js";
import type { StepMiddleware } from "../types/middleware.js";
import type { BoundToolDefinition } from "../types/tool.js";
import type { AdapterRegistry } from "./adapters.js";
import type { ModelRegistry } from "./models.js";
import { copyJson, deepFreeze } from "../utils/immutable.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const digest = (value: unknown): string =>
  createHash("sha256").update(canonical(value)).digest("hex");

export function createManifest(input: {
  capabilities: readonly Capability[];
  tools: readonly BoundToolDefinition[];
  instructions: readonly string[];
  middleware: readonly StepMiddleware[];
  models: ModelRegistry;
  adapters: AdapterRegistry;
}): CapabilityManifest {
  const capabilities = input.capabilities.map(({ id, version }) => ({
    id,
    ...(version ? { version } : {}),
  }));
  const tools = input.tools.map((tool) =>
    copyJson({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      executeWith: tool.executeWith,
      route: tool.route,
      jsonSchema: tool.input.jsonSchema,
      ...(tool.metadata ? { metadata: tool.metadata } : {}),
    }),
  );
  const instructions = [...input.instructions];
  const middleware = input.middleware.map(({ id, version }) => ({
    id,
    ...(version ? { version } : {}),
  }));
  const models = [...input.models.entries].map(([id, model]) => ({
    id,
    ...(model.version ? { version: model.version } : {}),
  }));
  const adapters = [...input.adapters.entries].map(([key, adapter]) => ({
    key,
    id: adapter.id,
    ...(adapter.version ? { version: adapter.version } : {}),
  }));
  const parts = {
    catalog: digest(tools),
    instructions: digest(instructions),
    middleware: digest(middleware),
    models: digest(models),
    adapters: digest(adapters),
  };
  return deepFreeze({
    capabilities,
    tools,
    instructions,
    middleware,
    models,
    adapters,
    digests: {
      ...parts,
      aggregate: digest({ capabilities, tools, instructions, middleware, models, adapters }),
    },
  });
}
