import type { BuildResult } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import type { ModelAdapter } from "../types/model.js";
import type { BuildDiagnostic } from "../types/shared.js";
import { bindAgent, type BuiltAgent } from "./agent.js";
import { createManifest } from "./manifest.js";

const diagnostic = (
  code: string,
  message: string,
  extra: Partial<BuildDiagnostic> = {},
): BuildDiagnostic => Object.freeze({ code, message, ...extra });

export function assembleAgent(
  middleware: readonly BoundMiddleware[],
  invoke: ModelAdapter,
  identity: Readonly<{ id: string; name: string }>,
): BuildResult<BuiltAgent> {
  const diagnostics: BuildDiagnostic[] = [];

  if (typeof identity.id !== "string" || identity.id.length === 0) {
    diagnostics.push(diagnostic("agent.invalid-id", "Agent id must be a non-empty string"));
  }
  if (typeof identity.name !== "string" || identity.name.length === 0) {
    diagnostics.push(diagnostic("agent.invalid-name", "Agent name must be a non-empty string"));
  }
  if (typeof invoke !== "function") {
    diagnostics.push(diagnostic("harness.invalid-model", "A model invoke function is required"));
  }

  const middlewareIds = new Set<string>();
  const frozen: BoundMiddleware[] = [];
  for (const item of middleware) {
    if (!item.id)
      diagnostics.push(diagnostic("middleware.invalid-id", "Middleware id must not be empty"));
    else if (middlewareIds.has(item.id))
      diagnostics.push(
        diagnostic("middleware.duplicate-id", `Duplicate middleware id '${item.id}'`),
      );
    else if (typeof item.handle !== "function")
      diagnostics.push(
        diagnostic("middleware.invalid", `Middleware '${item.id}' must provide a function`),
      );
    else {
      middlewareIds.add(item.id);
      frozen.push(
        Object.freeze({
          id: item.id,
          handle: item.handle,
          ...(item.state === undefined ? {} : { state: item.state }),
          ...(item.contributions === undefined ? {} : { contributions: item.contributions }),
        }),
      );
    }
  }

  if (diagnostics.length)
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
  const frozenMiddleware = Object.freeze(frozen);
  const manifest = createManifest({
    id: identity.id,
    name: identity.name,
    middleware: frozenMiddleware,
  });
  const agent = bindAgent(frozenMiddleware, invoke, manifest);
  return Object.freeze({ ok: true, agent, manifest });
}
