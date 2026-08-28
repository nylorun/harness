import type { BoundToolDefinition, ToolDefinition } from "../types/tool.js";
import { HarnessError } from "../errors.js";
import type { AdapterRegistry } from "./adapters.js";
import { normalizeSchema } from "./schema.js";

/** Binds one Tool definition against the Agent's adapter registry. */
export function bindTool(item: ToolDefinition, adapters: AdapterRegistry): BoundToolDefinition {
  if (!item.name) throw new HarnessError("tool.invalid-name", "Tool name must not be empty");
  adapters.require(item.executeWith);
  const parameters = normalizeSchema(item.parameters);
  return Object.freeze({
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    parameters,
    executeWith: item.executeWith,
  });
}
