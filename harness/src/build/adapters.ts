import type { JsonValue } from "../types/shared.js";
import type { ToolAdapter } from "../types/tool.js";
import { createFixedMap } from "../utils/maps.js";

export interface AdapterRegistry {
  readonly entries: ReadonlyMap<string, ToolAdapter<any>>;
  require<T extends ToolAdapter<any> = ToolAdapter<any>>(id: string): T;
}

export function createAdapterRegistry(adapters: readonly ToolAdapter[] = []): AdapterRegistry {
  const entries = new Map<string, ToolAdapter<JsonValue>>();
  for (const adapter of adapters) entries.set(adapter.id, adapter);
  return Object.freeze({
    entries: createFixedMap(entries),
    require<T extends ToolAdapter = ToolAdapter>(id: string): T {
      const adapter = entries.get(id);
      if (!adapter) throw new TypeError(`Tool adapter '${id}' is not registered`);
      return adapter as T;
    },
  });
}
