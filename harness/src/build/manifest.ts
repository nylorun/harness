import type { AgentManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import { deepFreeze } from "../utils/immutable.js";

export function createManifest(input: {
  id: string;
  name: string;
  middleware: readonly BoundMiddleware[];
}): AgentManifest {
  const middleware = input.middleware.map(({ id }) => ({ id }));
  return deepFreeze({
    id: input.id,
    name: input.name,
    middleware,
  });
}
