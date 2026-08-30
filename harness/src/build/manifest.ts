import type { AgentManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import { deepFreeze } from "../utils/immutable.js";

export function createManifest(input: { middleware: readonly BoundMiddleware[] }): AgentManifest {
  const middleware = input.middleware.map(({ id }) => ({ id }));
  return deepFreeze({
    middleware,
  });
}
