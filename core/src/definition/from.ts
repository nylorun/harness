import { HarnessError } from "../errors.js";
import type {
  AgentManifest,
  CapabilityManifest,
  ManifestTool,
} from "../types/manifest.js";
import type { BuiltAgent } from "../types/agent.js";
import type { JsonObject } from "../types/shared.js";
import type { ToolDefinition } from "../types/tool.js";
import type { StepMiddleware } from "../types/middleware.js";
import type { Implementations } from "./implementations.js";
import { assembleAgent } from "./assemble.js";
import type { CapabilityDynamics } from "./assemble.js";
import { schemaFromJSON } from "./schema-json.js";
import { deepFreeze } from "../utils/immutable.js";
import type { BoundMiddleware } from "./bound.js";

/** Rebuild an agent from manifest JSON + in-process implementations (T28). */
export function agentFrom<Info = unknown>(
  json: AgentManifest | JsonObject,
  implementations: Implementations<Info>
): BuiltAgent<Info> {
  const manifest = normalizeManifest(json);
  const entries: BoundMiddleware[] = [];
  const dynamics = new Map<string, CapabilityDynamics>();

  for (const capability of manifest.capabilities) {
    const impl = implementations[capability.id] ?? {};
    const tools = resolveTools(capability, impl.tools);
    if (capability.beforeModelCall && !impl.beforeModelCall)
      throw new HarnessError(
        "agent.build-failed",
        `Missing beforeModelCall implementation for capability '${capability.id}'`
      );
    if (capability.afterModelCall && !impl.afterModelCall)
      throw new HarnessError(
        "agent.build-failed",
        `Missing afterModelCall implementation for capability '${capability.id}'`
      );
    const handle: StepMiddleware =
      (impl.middleware as StepMiddleware | undefined) ??
      (async (request, next) => {
        if (tools.length)
          request.configuration.tools.set(
            capability.id,
            tools.map(
              (tool) =>
                implementations[capability.id]?.tools?.[tool.name] ?? tool
            )
          );
        if (capability.instructions)
          request.configuration.instructions.set(
            capability.id,
            capability.instructions
          );
        return next();
      });
    entries.push(
      Object.freeze({
        id: capability.id,
        handle,
        hasMiddleware:
          impl.middleware !== undefined || capability.hasMiddleware,
        tools:
          capability.tools !== undefined
            ? tools.map((tool) => {
                const live = impl.tools?.[tool.name];
                if (!live)
                  throw new HarnessError(
                    "agent.build-failed",
                    `Missing tool implementation '${tool.name}' for capability '${capability.id}'`
                  );
                return live;
              })
            : undefined,
        contributions: Object.freeze({
          ...(capability.instructions
            ? { instructions: capability.instructions }
            : {}),
          ...(capability.tools
            ? {
                tools: capability.tools.map((tool) =>
                  Object.freeze({
                    name: tool.name,
                    ...(tool.description === undefined
                      ? {}
                      : { description: tool.description }),
                  })
                ),
              }
            : {}),
        }),
        ...(capability.beforeModelCall ? { beforeModelCall: true } : {}),
        ...(capability.afterModelCall ? { afterModelCall: true } : {}),
      })
    );
    dynamics.set(capability.id, {
      ...(impl.beforeModelCall
        ? { beforeModelCall: impl.beforeModelCall as any }
        : {}),
      ...(impl.afterModelCall
        ? { afterModelCall: impl.afterModelCall as any }
        : {}),
      ...(impl.middleware ? { middleware: impl.middleware as any } : {}),
    });
  }

  const outputSchema = manifest.outputSchema
    ? schemaFromJSON(manifest.outputSchema)
    : undefined;

  const result = assembleAgent(
    entries,
    { id: manifest.id, name: manifest.name, outputSchema },
    dynamics
  );
  if (!result.ok)
    throw new HarnessError(
      "agent.build-failed",
      result.diagnostics.map((item) => item.message).join("; ")
    );
  return result.agent as BuiltAgent<Info>;
}

function resolveTools(
  capability: CapabilityManifest,
  tools: Implementations[string]["tools"] | undefined
): ToolDefinition[] {
  if (!capability.tools?.length) return [];
  return capability.tools.map((tool) => {
    const live = tools?.[tool.name];
    if (!live)
      throw new HarnessError(
        "agent.build-failed",
        `Missing tool implementation '${tool.name}' for capability '${capability.id}'`
      );
    return live;
  });
}

function normalizeManifest(json: AgentManifest | JsonObject): AgentManifest {
  if (!json || typeof json !== "object" || Array.isArray(json))
    throw new HarnessError(
      "agent.build-failed",
      "Agent.from requires a manifest object"
    );
  const value = json as Record<string, unknown>;
  if (typeof value.id !== "string" || !value.id)
    throw new HarnessError(
      "agent.build-failed",
      "Manifest id must be a non-empty string"
    );
  if (typeof value.name !== "string" || !value.name)
    throw new HarnessError(
      "agent.build-failed",
      "Manifest name must be a non-empty string"
    );
  if (!Array.isArray(value.capabilities))
    throw new HarnessError(
      "agent.build-failed",
      "Manifest capabilities must be an array"
    );
  const schemaVersion =
    value.schemaVersion === undefined ? 2 : value.schemaVersion;
  if (schemaVersion !== 2)
    throw new HarnessError(
      "agent.build-failed",
      `Unsupported manifest schemaVersion ${schemaVersion}`
    );
  // Reject top-level model (Runtime-owned).
  if ("model" in value && value.model !== undefined)
    throw new HarnessError(
      "agent.build-failed",
      "Manifest must not include top-level model; Runtime owns model resolution"
    );
  return deepFreeze({
    schemaVersion: 2 as const,
    id: value.id,
    name: value.name,
    ...(value.outputSchema && typeof value.outputSchema === "object"
      ? { outputSchema: value.outputSchema as JsonObject }
      : {}),
    capabilities: (value.capabilities as CapabilityManifest[]).map(
      normalizeCapability
    ),
  });
}

function normalizeCapability(
  capability: CapabilityManifest
): CapabilityManifest {
  return Object.freeze({
    id: capability.id,
    kind: capability.kind ?? "capability",
    hasMiddleware: capability.hasMiddleware ?? false,
    ...(capability.instructions
      ? { instructions: Object.freeze([...capability.instructions]) }
      : {}),
    ...(capability.tools
      ? { tools: Object.freeze(capability.tools.map(normalizeTool)) }
      : {}),
    ...(capability.beforeModelCall ? { beforeModelCall: true } : {}),
    ...(capability.afterModelCall ? { afterModelCall: true } : {}),
  });
}

function normalizeTool(tool: ManifestTool): ManifestTool {
  return Object.freeze({
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    inputSchema: tool.inputSchema,
    ...(tool.outputSchema === undefined
      ? {}
      : { outputSchema: tool.outputSchema }),
  });
}
