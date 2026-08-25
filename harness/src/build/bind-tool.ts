import type { BoundToolDefinition, ToolDefinition } from "../types/tool.js";
import { copyJson, copyJsonObject } from "../utils/immutable.js";
import type { AdapterRegistry } from "./adapters.js";
import { normalizeSchema } from "./schema.js";

/** Binds one Tool definition against the Agent's adapter registry. Copies route and metadata. */
export function bindTool(item: ToolDefinition, adapters: AdapterRegistry): BoundToolDefinition {
  if (!item.name) throw new TypeError("Tool name must not be empty");
  const adapter = adapters.require(item.executeWith);
  const route = copyJson(item.route);
  adapter.validateRoute(route);
  const input = normalizeSchema(item.input);
  const metadata =
    item.metadata === undefined
      ? undefined
      : copyJsonObject(item.metadata, `tool '${item.name}' metadata`);
  return Object.freeze({
    name: item.name,
    ...(item.description ? { description: item.description } : {}),
    input,
    executeWith: item.executeWith,
    route,
    ...(metadata ? { metadata } : {}),
  });
}
