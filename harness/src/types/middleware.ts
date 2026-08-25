import type { ModelCandidate, ModelDirective, ModelToolCall } from "./model.js";
import type { InputEvent, TranscriptEntry } from "./session.js";
import type { ContextItem, JsonObject, Tripwire } from "./shared.js";
import type { Interaction, ToolDefinition, ToolResult } from "./tool.js";

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
    readonly context?: JsonObject;
  }>;
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  readonly transcript: readonly TranscriptEntry[];
}

export interface StepRequest {
  readonly session: StepInput["session"];
  readonly turnNumber: number;
  readonly stepNumber: number;
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  readonly transcript: readonly TranscriptEntry[];
  readonly instructions: { add(...items: string[]): void };
  readonly context: { add(...items: ContextItem[]): void };
  readonly tools: {
    add(...tools: ToolDefinition[]): void;
    hide(...toolNames: string[]): void;
  };
  readonly model: { select(directive: ModelDirective): void };
  tripwire(error: Tripwire): StepResponse;
}

export interface StepResponse {
  candidate(): Readonly<ModelCandidate> | undefined;
  toolCalls(): readonly ModelToolCall[];
  replace(candidate: ModelCandidate): void;
  deny(callId: string, reason: string): void;
  requireInteraction(callId: string, interaction: Interaction): void;
  requirePreflight(callId: string, kind: "sandbox" | "validation"): void;
  tripwire(error: Tripwire): void;
}

export type StepMiddleware = (
  request: StepRequest,
  next: () => Promise<StepResponse>,
) => Promise<StepResponse>;

export interface BoundMiddleware {
  readonly id: string;
  readonly version?: string;
  readonly handle: StepMiddleware;
}
