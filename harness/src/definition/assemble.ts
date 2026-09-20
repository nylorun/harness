import type { BoundMiddleware } from "./bound.js";
import type { BuiltAgent } from "../types/agent.js";
import type { AgentManifest } from "../types/manifest.js";
import type { BuildDiagnostic } from "../types/shared.js";
import type { ToolSchemaSource } from "../types/tool.js";
import type { AfterModelCallFn, BeforeModelCallFn } from "../types/dynamics.js";
import type { StepMiddleware } from "../types/middleware.js";
import { bindAgent } from "./bind-agent.js";
import type { AgentDefinition } from "./agent-definition.js";
import { createManifest } from "./manifest.js";

type BuildResult<Agent> =
  | { readonly ok: true; readonly agent: Agent; readonly manifest: AgentManifest }
  | { readonly ok: false; readonly diagnostics: readonly BuildDiagnostic[] };

export interface CapabilityDynamics {
  readonly beforeModelCall?: BeforeModelCallFn<any>;
  readonly afterModelCall?: AfterModelCallFn<any>;
  readonly middleware?: StepMiddleware<any>;
}

const diagnostic = (
  code: string,
  message: string,
  extra: Partial<BuildDiagnostic> = {},
): BuildDiagnostic => Object.freeze({ code, message, ...extra });

export function assembleAgent(
  middleware: readonly BoundMiddleware[],
  identity: Readonly<{
    id: string;
    name: string;
    outputSchema?: ToolSchemaSource;
  }>,
  dynamics: ReadonlyMap<string, CapabilityDynamics> = new Map(),
): BuildResult<BuiltAgent> {
  const diagnostics: BuildDiagnostic[] = [];

  if (typeof identity.id !== "string" || identity.id.length === 0) {
    diagnostics.push(diagnostic("agent.invalid-id", "Agent id must be a non-empty string"));
  }
  if (typeof identity.name !== "string" || identity.name.length === 0) {
    diagnostics.push(diagnostic("agent.invalid-name", "Agent name must be a non-empty string"));
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
          hasMiddleware: item.hasMiddleware,
          ...(item.tools === undefined ? {} : { tools: item.tools }),
          ...(item.contributions === undefined ? {} : { contributions: item.contributions }),
          ...(item.beforeModelCall ? { beforeModelCall: true } : {}),
          ...(item.afterModelCall ? { afterModelCall: true } : {}),
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
    outputSchema: identity.outputSchema,
    middleware: frozenMiddleware,
  });
  const agent = bindAgent(frozenMiddleware, manifest, identity, dynamics);
  return Object.freeze({ ok: true, agent, manifest });
}
