import type { BuildResult } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import type { BuildDiagnostic } from "../types/shared.js";
import type { ToolAdapter } from "../types/tool.js";
import { bindAgent, type BuiltAgent } from "../agent.js";
import { createAdapterRegistry } from "./adapters.js";
import { createManifest } from "./manifest.js";
import type { ModelInvoker } from "../types/model.js";

const diagnostic = (
  code: string,
  message: string,
  extra: Partial<BuildDiagnostic> = {},
): BuildDiagnostic => Object.freeze({ code, message, ...extra });

export function assembleAgent(
  middleware: readonly BoundMiddleware[],
  model: ModelInvoker,
  adapters: readonly ToolAdapter[],
): BuildResult<BuiltAgent> {
  const diagnostics: BuildDiagnostic[] = [];

  const adapterIds = new Set<string>();
  const validAdapters: ToolAdapter[] = [];
  for (const adapter of adapters) {
    const id = adapter?.id;
    if (!id) diagnostics.push(diagnostic("adapter.invalid-id", "Adapter id must not be empty"));
    else if (adapterIds.has(id))
      diagnostics.push(diagnostic("adapter.duplicate-id", `Duplicate adapter id '${id}'`));
    else if (typeof adapter.validateRoute !== "function" || typeof adapter.execute !== "function")
      diagnostics.push(
        diagnostic("adapter.invalid", `Adapter '${id}' must provide validateRoute() and execute()`),
      );
    else {
      adapterIds.add(id);
      validAdapters.push(adapter);
    }
  }

  if (!model || typeof model.invoke !== "function") {
    diagnostics.push(
      diagnostic("harness.invalid-model", "A model invoker with invoke() is required"),
    );
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
          ...(item.version === undefined ? {} : { version: item.version }),
          handle: item.handle,
        }),
      );
    }
  }

  if (diagnostics.length)
    return Object.freeze({ ok: false, diagnostics: Object.freeze(diagnostics) });
  const frozenMiddleware = Object.freeze(frozen);
  const frozenModel = Object.freeze({
    ...(model.id === undefined ? {} : { id: model.id }),
    ...(model.version === undefined ? {} : { version: model.version }),
    invoke: model.invoke.bind(model),
  });
  const registry = createAdapterRegistry(Object.freeze(validAdapters));
  const manifest = createManifest({
    middleware: frozenMiddleware,
    model: frozenModel,
    adapters: registry,
  });
  const agent = bindAgent(frozenMiddleware, frozenModel, registry, manifest);
  return Object.freeze({ ok: true, agent, manifest });
}
