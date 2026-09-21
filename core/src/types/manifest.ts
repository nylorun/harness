import type { ModelDirective } from "./model.js";
import type { JsonObject } from "./shared.js";

/** Published manifest schema version (no top-level model — Runtime-owned). */
export type ManifestSchemaVersion = 2;

export interface ManifestTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
}

export interface CapabilityManifest {
  readonly id: string;
  readonly kind: "agent" | "capability" | "middleware";
  /** @deprecated Prefer beforeModelCall / afterModelCall flags. */
  readonly hasMiddleware: boolean;
  readonly instructions?: readonly string[];
  readonly tools?: readonly ManifestTool[];
  /** True when an implementations entry provides beforeModelCall for this capability. */
  readonly beforeModelCall?: boolean;
  /** True when an implementations entry provides afterModelCall for this capability. */
  readonly afterModelCall?: boolean;
  /**
   * @deprecated Model resolution is Runtime-owned. Legacy local snapshots may still carry this;
   * new manifests omit it.
   */
  readonly model?: Pick<ModelDirective, "id" | "controls">;
}

export interface AgentManifest {
  readonly schemaVersion: ManifestSchemaVersion;
  readonly id: string;
  readonly name: string;
  readonly outputSchema?: JsonObject;
  readonly capabilities: readonly CapabilityManifest[];
}
