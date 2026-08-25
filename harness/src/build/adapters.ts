import type { JsonValue } from "../types/shared.js";
import type { ToolAdapter } from "../types/tool.js";
import { createFixedMap } from "../utils/maps.js";

export type AdapterInput = Readonly<Record<string, ToolAdapter<any>>>;

export interface AdapterRegistry {
  readonly entries: ReadonlyMap<string, ToolAdapter<any>>;
  require<T extends ToolAdapter<any> = ToolAdapter<any>>(key: string): T;
}

export function createAdapterRegistry(input: AdapterInput = {}): AdapterRegistry {
  const entries = new Map<string, ToolAdapter<JsonValue>>(Object.entries(input));
  for (const [key, adapter] of entries) {
    if (
      !key ||
      !adapter ||
      typeof adapter.id !== "string" ||
      typeof adapter.validateRoute !== "function" ||
      typeof adapter.execute !== "function"
    ) {
      throw new TypeError(`Invalid Tool adapter '${key}'`);
    }
  }
  return Object.freeze({
    entries: createFixedMap(entries),
    require<T extends ToolAdapter = ToolAdapter>(key: string): T {
      const adapter = entries.get(key);
      if (!adapter) throw new TypeError(`Tool adapter '${key}' is not registered`);
      return adapter as T;
    },
  });
}
