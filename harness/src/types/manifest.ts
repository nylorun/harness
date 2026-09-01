import type { BoundMiddleware } from "./middleware.js";
import type { BuildDiagnostic } from "./shared.js";

export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly middleware: readonly { readonly id: string }[];
}

export type BuildResult<Agent> =
  | { readonly ok: true; readonly agent: Agent; readonly manifest: AgentManifest }
  | { readonly ok: false; readonly diagnostics: readonly BuildDiagnostic[] };

export type { BoundMiddleware };
