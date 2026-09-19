import type { BoundMiddleware } from "./bound.js";
import type { AgentManifest, CapabilityManifest, ManifestTool } from "../types/manifest.js";
import type { ToolSchemaSource } from "../types/tool.js";
import { bindOutputContract } from "./output-contract.js";
import { normalizedSchemasFor } from "./schema.js";

import { deepFreeze } from "../utils/immutable.js";

export function createManifest(input: {
  id: string;
  name: string;
  outputSchema?: ToolSchemaSource;
  middleware: readonly BoundMiddleware[];
}): AgentManifest {
  const capabilities = input.middleware.map((item) => projectCapability(item));
  return deepFreeze({
    schemaVersion: 2 as const,
    id: input.id,
    name: input.name,
    ...(input.outputSchema === undefined
      ? {}
      : { outputSchema: bindOutputContract(input.outputSchema).schema.jsonSchema }),
    capabilities,
  });
}

function projectCapability(item: BoundMiddleware): CapabilityManifest {
  const contributions = item.contributions;
  return {
    id: item.id,
    kind: capabilityKind(item),
    hasMiddleware: item.hasMiddleware,
    ...(contributions?.instructions === undefined
      ? {}
      : { instructions: contributions.instructions }),
    ...(item.tools === undefined ? {} : { tools: item.tools.map((tool) => projectTool(tool)) }),
    ...(item.beforeModelCall ? { beforeModelCall: true } : {}),
    ...(item.afterModelCall ? { afterModelCall: true } : {}),
    // Deliberately omit capability.model from new manifests (Runtime-owned).
  };
}

function capabilityKind(item: BoundMiddleware): CapabilityManifest["kind"] {
  if (item.id === "agent") return "agent";
  if (item.contributions !== undefined || item.beforeModelCall || item.afterModelCall)
    return "capability";
  return "middleware";
}

function projectTool(tool: NonNullable<BoundMiddleware["tools"]>[number]): ManifestTool {
  const schemas = normalizedSchemasFor(tool);
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: schemas.inputSchema.jsonSchema,
    ...(schemas.outputSchema === undefined
      ? {}
      : { outputSchema: schemas.outputSchema.jsonSchema }),
  };
}
