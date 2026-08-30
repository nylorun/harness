import type { BoundToolDefinition, ToolDefinition } from "../types/tool.js";
import { HarnessError } from "../errors.js";
import { normalizedSchemaFor } from "./schema.js";

/** Prepares an executable Tool and records its middleware slot provenance. */
export function bindTool(
  item: ToolDefinition,
  owner: BoundToolDefinition["owner"],
): BoundToolDefinition {
  if (!item.name) throw new HarnessError("tool.invalid-name", "Tool name must not be empty");
  if (typeof item.execute !== "function")
    throw new HarnessError("tool.invalid", `Tool '${item.name}' must provide execute()`);
  const parameters = normalizedSchemaFor(item);
  return Object.freeze({
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    parameters: parameters as BoundToolDefinition["parameters"],
    execute: item.execute.bind(item) as BoundToolDefinition["execute"],
    owner: Object.freeze({ ...owner }),
  });
}
