import type { BoundMiddleware, MiddlewareContributions } from "./middleware.js";
import type { BuildDiagnostic } from "./shared.js";

export interface MiddlewareManifest extends MiddlewareContributions {
  readonly id: string;
}

export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly middleware: readonly MiddlewareManifest[];
}

export type BuildResult<Agent> =
  | { readonly ok: true; readonly agent: Agent; readonly manifest: AgentManifest }
  | { readonly ok: false; readonly diagnostics: readonly BuildDiagnostic[] };

export type { BoundMiddleware };
