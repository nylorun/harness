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
): BuildResult<BuiltAgent> {
  const diagnostics: BuildDiagnostic[] = [];

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
        }),
      );
    }
  }

  if (diagnostics.length)
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
  const frozenMiddleware = Object.freeze(frozen);
  const manifest = createManifest({ middleware: frozenMiddleware });
  const agent = bindAgent(frozenMiddleware, invoke, manifest);
  return Object.freeze({ ok: true, agent, manifest });
}
