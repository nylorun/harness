import type { AgentManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import type { ModelInvoker } from "../types/model.js";
import { deepFreeze } from "../utils/immutable.js";
import type { AdapterRegistry } from "./adapters.js";

export function createManifest(input: {
  middleware: readonly BoundMiddleware[];
  model: ModelInvoker;
  adapters: AdapterRegistry;
}): AgentManifest {
  const middleware = input.middleware.map(({ id, version }) => ({
    id,
    ...(version ? { version } : {}),
  }));
  const model =
    input.model.id === undefined
      ? undefined
      : {
          id: input.model.id,
          ...(input.model.version ? { version: input.model.version } : {}),
        };
  const adapters = [...input.adapters.entries].map(([, adapter]) => ({
    id: adapter.id,
    ...(adapter.version ? { version: adapter.version } : {}),
  }));
  return deepFreeze({
    middleware,
    ...(model === undefined ? {} : { model }),
    adapters,
  });
}
