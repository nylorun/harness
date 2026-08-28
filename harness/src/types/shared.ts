import type {
  ContextSnapshot,
  ModelCandidate,
  ModelDirective,
  ModelCall,
  ModelConfigurationSnapshot,
} from "./model.js";
import type { InputEvent, TranscriptEntry } from "./session.js";
import type { RequiredInteraction, ToolResult } from "./tool.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface BuildDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly toolName?: string;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
  readonly cause?: unknown;
}

export interface ContextItem {
  readonly type?: string;
  readonly value: JsonValue;
}

export interface Tripwire {
  readonly code: string;
  readonly message: string;
  readonly scope?: "step" | "session";
}

export interface ObserveToolSnapshot {
  readonly name: string;
  readonly description?: string;
  readonly executeWith: string;
  readonly parameters: { readonly jsonSchema: JsonObject };
}

/** JSON-only model-configuration view suitable for an observation stream. */
export interface ObserveModelConfigurationSnapshot extends Omit<
  ModelConfigurationSnapshot,
  "tools"
> {
  readonly tools: readonly ObserveToolSnapshot[];
}

export interface ObserveSealedCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly executeWith: string;
  readonly invocationId: string;
  readonly preflight?: "sandbox" | "validation";
  readonly interaction?: RequiredInteraction;
}

export interface ObserveModelRequested {
  /** The exact immutable logical input supplied to the ModelAdapter. */
  readonly call: ModelCall;
  /** Canonical configuration facts and attribution; hashes have no policy semantics. */
  readonly configuration: ObserveModelConfigurationSnapshot;
  /** Current-step runtime context and attribution. */
  readonly context: ContextSnapshot;
}

export type ObserveEvent =
  | { readonly type: "session.stopped"; readonly reason: string }
  | { readonly type: "input.received"; readonly inputId: string; readonly kind: string }
  | { readonly type: "input.queued"; readonly inputId: string }
  | { readonly type: "input.rejected"; readonly inputId: string; readonly reason: string }
  | { readonly type: "input.cancelled"; readonly inputId: string; readonly reason: string }
  | {
      readonly type: "model.requested";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly requestedModelId?: string;
      readonly attributes: ObserveModelRequested;
    }
  | {
      readonly type: "model.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly requestedModelId?: string;
      readonly attributes: ModelCandidate;
    }
  | {
      readonly type: "step.started";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly turnNumber: number;
      readonly stepNumber: number;
      readonly attributes: {
        readonly session?: { readonly userId?: string; readonly context?: JsonObject };
        readonly arrivals: readonly InputEvent[];
        readonly toolResults: readonly ToolResult[];
        readonly transcript: readonly TranscriptEntry[];
      };
    }
  | {
      readonly type: "middleware.entered" | "middleware.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly middlewareId: string;
    }
  | {
      readonly type: "middleware.lease-violation";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly middlewareId: string;
      readonly reason: string;
    }
  | {
      readonly type: "tool.sealed";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly attributes: {
        readonly executable: readonly ObserveSealedCall[];
        readonly immediate: readonly ToolResult[];
      };
    }
  | {
      readonly type: "adapter.preflight.started" | "adapter.started";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly adapterId: string;
      readonly toolName: string;
      readonly callId: string;
      readonly invocationId?: string;
      readonly attributes: { readonly args: JsonValue };
    }
  | {
      readonly type: "adapter.preflight.completed" | "adapter.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly adapterId: string;
      readonly toolName: string;
      readonly callId: string;
      readonly outcome: string;
      readonly code?: string;
      readonly attributes?: ToolResult;
    }
  | {
      readonly type: "turn.completed";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly attributes: { readonly output: string };
    }
  | {
      readonly type: "interaction.required";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly interactionId: string;
      readonly kind: string;
      readonly callId?: string;
      readonly toolName?: string;
      readonly phase?: "interaction" | "preflight" | "execute";
      readonly attributes: { readonly prompt: string; readonly metadata?: JsonObject };
    }
  | {
      readonly type: "tripwire";
      readonly turnId: string;
      readonly stepId?: string;
      readonly inputId?: string;
      readonly code: string;
      readonly scope: string;
      readonly attributes: { readonly message: string };
    };

export type Observer = (event: ObserveEvent) => void | Promise<void>;
