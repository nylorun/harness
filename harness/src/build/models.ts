import type { ModelInvoker, ModelRegistryInput } from "../types/model.js";
import { createFixedMap } from "../utils/maps.js";

export interface ModelRegistry {
  readonly defaultModel: string;
  readonly entries: ReadonlyMap<string, ModelInvoker>;
  require(id: string): ModelInvoker;
}

export function createModelRegistry(input: {
  model?: ModelInvoker;
  models?: ModelRegistryInput;
  defaultModel?: string;
}): ModelRegistry {
  if (input.model && input.models) {
    throw new TypeError("Provide either model or models, not both");
  }
  const source: ModelRegistryInput = input.models ?? (input.model ? { default: input.model } : {});
  const names = Object.keys(source);
  if (names.length === 0) {
    throw new TypeError("At least one model is required");
  }
  for (const name of names) {
    if (!name || typeof source[name]?.invoke !== "function") {
      throw new TypeError(`Invalid model '${name}'`);
    }
  }
  const defaultModel = input.defaultModel ?? ("default" in source ? "default" : names[0]!);
  if (!(defaultModel in source)) {
    throw new TypeError(`Default model '${defaultModel}' is not bound`);
  }
  const entries = new Map(Object.entries(source));
  return Object.freeze({
    defaultModel,
    entries: createFixedMap(entries),
    require(id: string): ModelInvoker {
      const model = entries.get(id);
      if (!model) {
        throw new TypeError(`Model '${id}' is not bound`);
      }
      return model;
    },
  });
}
