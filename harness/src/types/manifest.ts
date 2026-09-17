import type { ModelDirective } from "./model.js";
import type { JsonObject } from "./shared.js";

export interface ManifestTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly outputSchema?: JsonObject;
}

export interface CapabilityManifest {
  readonly id: string;
  readonly kind: "agent" | "capability" | "middleware";
  readonly hasMiddleware: boolean;
  readonly instructions?: readonly string[];
  readonly tools?: readonly ManifestTool[];
  readonly model?: Pick<ModelDirective, "id" | "controls">;
}

export interface AgentManifest {
  readonly id: string;
  readonly name: string;
  readonly outputSchema?: JsonObject;
  readonly capabilities: readonly CapabilityManifest[];
}
