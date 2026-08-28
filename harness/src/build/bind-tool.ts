import type { BoundToolDefinition, ToolDefinition } from "../types/tool.js";
import { HarnessError } from "../errors.js";
import type { AdapterRegistry } from "./adapters.js";
import { normalizedSchemaFor } from "./schema.js";

/** Binds one Tool definition against the Agent's adapter registry. */
export function bindTool(item: ToolDefinition, adapters: AdapterRegistry): BoundToolDefinition {
  if (!item.name) throw new HarnessError("tool.invalid-name", "Tool name must not be empty");
  adapters.require(item.executeWith);
  const parameters = normalizedSchemaFor(item);
  return Object.freeze({
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    parameters: parameters as BoundToolDefinition["parameters"],
    executeWith: item.executeWith,
  });
}
