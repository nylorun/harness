import type { BoundModelId, ModelCandidate } from "./model.js";
import type { InputEvent } from "./session.js";
import type { ContextItem, Tripwire } from "./shared.js";
import type { Interaction, ToolResult } from "./tool.js";

export interface StepInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  /** One-based position of this turn within the Session. */
  readonly turnNumber: number;
  /** One-based position of this Model Step within the Turn. */
  readonly stepNumber: number;
  readonly session: Readonly<{
    readonly userId?: string;
    readonly context?: import("./shared.js").JsonObject;
  }>;
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
}

export interface BeforeModelContext {
  readonly input: Readonly<StepInput>;
  addInstructions(...items: string[]): void;
  addContext(...items: ContextItem[]): void;
  hideTools(...toolNames: string[]): void;
  selectModel(modelId: BoundModelId): void;
  tripwire(error: Tripwire): void;
}

export interface AfterModelContext {
  readonly input: Readonly<StepInput>;
  candidate(): Readonly<ModelCandidate> | undefined;
  denyTool(callId: string, reason: string): void;
  requireInteraction(callId: string, interaction: Interaction): void;
  requirePreflight(callId: string, kind: "sandbox" | "validation"): void;
  tripwire(error: Tripwire): void;
}

export interface StepMiddleware {
  readonly id: string;
  readonly version?: string;
  beforeModel?(ctx: BeforeModelContext): void | Promise<void>;
  aroundModel?(ctx: AfterModelContext, next: () => Promise<void>): Promise<void>;
}
