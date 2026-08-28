import type { ToolAdapter } from "../types/tool.js";
import { HarnessError } from "../errors.js";
import { createFixedMap } from "../utils/maps.js";

export interface AdapterRegistry {
  readonly entries: ReadonlyMap<string, ToolAdapter>;
  require<T extends ToolAdapter = ToolAdapter>(id: string): T;
}

export function createAdapterRegistry(adapters: readonly ToolAdapter[] = []): AdapterRegistry {
  const entries = new Map<string, ToolAdapter>();
  for (const adapter of adapters) entries.set(adapter.id, adapter);
  return Object.freeze({
    entries: createFixedMap(entries),
    require<T extends ToolAdapter = ToolAdapter>(id: string): T {
      const adapter = entries.get(id);
      if (!adapter)
        throw new HarnessError("adapter.not-registered", `Tool adapter '${id}' is not registered`, {
          details: { adapterId: id },
        });
      return adapter as T;
    },
  });
}
