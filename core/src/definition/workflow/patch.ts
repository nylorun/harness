import type { AgentManifest, ToolManifest } from "../../types/manifest.js";
import { deepFreeze } from "../../utils/immutable.js";

function primaryCapabilityIndex(manifest: AgentManifest): number {
  const agentIdx = manifest.capabilities.findIndex((c) => c.id === "agent");
  return agentIdx >= 0 ? agentIdx : 0;
}

/**
 * Append instruction text to the agent's primary capability (loops.md §3.3).
 * Pure: returns a new manifest; never mutates.
 */
export function withInstructions(manifest: AgentManifest, text: string): AgentManifest {
  if (typeof text !== "string" || text.length === 0)
    throw new TypeError("withInstructions requires a non-empty string");
  if (manifest.capabilities.length === 0)
    throw new TypeError("withInstructions requires a manifest with at least one capability");
  const index = primaryCapabilityIndex(manifest);
  const capabilities = manifest.capabilities.map((cap, i) => {
    if (i !== index) return cap;
    return {
      ...cap,
      instructions: Object.freeze([...(cap.instructions ?? []), text]),
    };
  });
  return deepFreeze({ ...manifest, capabilities });
}

/**
 * Remove named tools from every capability (loops.md §3.3). Pure.
 * Tools may be removed, not added — matches Loop variant rules.
 */
export function withoutTools(
  manifest: AgentManifest,
  names: readonly string[],
): AgentManifest {
  const remove = new Set(names);
  const capabilities = manifest.capabilities.map((cap) => {
    if (!cap.tools?.length) return cap;
    const tools = cap.tools.filter((tool: ToolManifest) => !remove.has(tool.name));
    if (tools.length === cap.tools.length) return cap;
    if (tools.length === 0) {
      const { tools: _dropped, ...rest } = cap;
      return rest;
    }
    return { ...cap, tools: Object.freeze(tools) };
  });
  return deepFreeze({ ...manifest, capabilities });
}
