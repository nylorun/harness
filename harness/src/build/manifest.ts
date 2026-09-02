import type { AgentManifest, MiddlewareManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import { deepFreeze } from "../utils/immutable.js";

export function createManifest(input: {
  id: string;
  name: string;
  middleware: readonly BoundMiddleware[];
}): AgentManifest {
  const middleware = input.middleware.map((item) => projectMiddleware(item));
  return deepFreeze({
    id: input.id,
    name: input.name,
    middleware,
  });
}

function projectMiddleware(item: BoundMiddleware): MiddlewareManifest {
  const contributions = item.contributions;
  return {
    id: item.id,
    ...(contributions?.instructions === undefined
      ? {}
      : { instructions: contributions.instructions }),
    ...(contributions?.tools === undefined ? {} : { tools: contributions.tools }),
    ...(contributions?.model === undefined ? {} : { model: contributions.model }),
  };
}
