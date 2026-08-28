import type { AgentManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import type { ModelDirective } from "../types/model.js";
import { deepFreeze } from "../utils/immutable.js";
import type { AdapterRegistry } from "./adapters.js";

export function createManifest(input: {
  middleware: readonly BoundMiddleware[];
  directive?: ModelDirective;
  adapters: AdapterRegistry;
}): AgentManifest {
  const middleware = input.middleware.map(({ id }) => ({ id }));
  const adapters = [...input.adapters.entries].map(([, entry]) => ({
    id: entry.adapter.id,
    ...(entry.options.maxConcurrentCalls === undefined
      ? {}
      : { maxConcurrentCalls: entry.options.maxConcurrentCalls }),
  }));
  return deepFreeze({
    middleware,
    ...(input.directive === undefined ? {} : { model: input.directive }),
    adapters,
  });
}
