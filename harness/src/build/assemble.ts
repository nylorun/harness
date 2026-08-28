import type { BuildResult } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import type { ModelAdapter, ModelDirective } from "../types/model.js";
import { normalizeDirective } from "../model-normalize.js";
import type { BuildDiagnostic } from "../types/shared.js";
import type { ToolAdapter } from "../types/tool.js";
import { isHarnessError } from "../errors.js";
import { bindAgent, type BuiltAgent } from "./agent.js";
import { createAdapterRegistry } from "./adapters.js";
import { createManifest } from "./manifest.js";

const diagnostic = (
  code: string,
  message: string,
  extra: Partial<BuildDiagnostic> = {},
): BuildDiagnostic => Object.freeze({ code, message, ...extra });

export function assembleAgent(
  middleware: readonly BoundMiddleware[],
  invoke: ModelAdapter,
  adapters: readonly ToolAdapter[],
  directive?: ModelDirective,
): BuildResult<BuiltAgent> {
  const diagnostics: BuildDiagnostic[] = [];

  const adapterIds = new Set<string>();
  const validAdapters: ToolAdapter[] = [];
  for (const adapter of adapters) {
    const id = adapter?.id;
    if (!id) diagnostics.push(diagnostic("adapter.invalid-id", "Adapter id must not be empty"));
    else if (adapterIds.has(id))
      diagnostics.push(diagnostic("adapter.duplicate-id", `Duplicate adapter id '${id}'`));
    else if (typeof adapter.execute !== "function")
      diagnostics.push(diagnostic("adapter.invalid", `Adapter '${id}' must provide execute()`));
    else {
      adapterIds.add(id);
      validAdapters.push(adapter);
    }
  }

  if (typeof invoke !== "function") {
    diagnostics.push(diagnostic("harness.invalid-model", "A model invoke function is required"));
  }

  let frozenDirective: ModelDirective | undefined;
  if (directive !== undefined) {
    const normalized = normalizeDirective(directive);
    if (isHarnessError(normalized))
      diagnostics.push(
        diagnostic(normalized.code, normalized.message, {
          ...(Object.keys(normalized.details).length ? { details: normalized.details } : {}),
          ...(normalized.cause === undefined ? {} : { cause: normalized.cause }),
        }),
      );
    else frozenDirective = normalized;
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
        }),
      );
    }
  }

  if (diagnostics.length)
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
  const frozenMiddleware = Object.freeze(frozen);
  const registry = createAdapterRegistry(Object.freeze(validAdapters));
  const manifest = createManifest({
    middleware: frozenMiddleware,
    ...(frozenDirective === undefined ? {} : { directive: frozenDirective }),
    adapters: registry,
  });
  const agent = bindAgent(frozenMiddleware, invoke, registry, manifest, frozenDirective);
  return Object.freeze({ ok: true, agent, manifest });
}
