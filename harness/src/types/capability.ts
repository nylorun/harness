import type { StepMiddleware } from "./middleware.js";
import type { BuildDiagnostic } from "./shared.js";
import type { ToolAdapter, ToolDefinition } from "./tool.js";

export interface CapabilitySetupContext {
  readonly adapters: { require<T extends ToolAdapter = ToolAdapter>(id: string): T };
}

export interface CapabilityContribution {
  readonly tools?: readonly ToolDefinition[];
  readonly middleware?: readonly StepMiddleware[];
  readonly instructions?: readonly string[];
}

export interface Capability {
  readonly id: string;
  readonly version?: string;
  readonly middleware?: readonly StepMiddleware[];
  setup?(context: CapabilitySetupContext): CapabilityContribution | Promise<CapabilityContribution>;
}

export interface CapabilityManifestTool {
  readonly name: string;
  readonly description?: string;
  readonly executeWith: string;
  readonly route: import("./shared.js").JsonValue;
  readonly jsonSchema: import("./shared.js").JsonObject;
  readonly metadata?: import("./shared.js").JsonObject;
}

export interface CapabilityManifest {
  readonly capabilities: readonly { readonly id: string; readonly version?: string }[];
  readonly tools: readonly CapabilityManifestTool[];
  readonly instructions: readonly string[];
  readonly middleware: readonly { readonly id: string; readonly version?: string }[];
  readonly models: readonly { readonly id: string; readonly version?: string }[];
  readonly adapters: readonly {
    readonly key: string;
    readonly id: string;
    readonly version?: string;
  }[];
  readonly digests: Readonly<
    Record<"catalog" | "instructions" | "middleware" | "models" | "adapters" | "aggregate", string>
  >;
}

export type BuildResult<Agent> =
  | { readonly ok: true; readonly agent: Agent; readonly manifest: CapabilityManifest }
  | { readonly ok: false; readonly diagnostics: readonly BuildDiagnostic[] };
