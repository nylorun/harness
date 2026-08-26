import type { ModelCandidate, ModelDirective, PromptPrefixSnapshot } from "./model.js";
import type { InputEvent, TranscriptEntry } from "./session.js";
import type { RequiredInteraction, ToolResult } from "./tool.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };

export interface BuildDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly capabilityId?: string;
  readonly toolName?: string;
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
  readonly route: JsonValue;
  readonly metadata?: JsonObject;
  readonly input: { readonly jsonSchema: JsonObject };
}

export interface ObserveSealedCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly executeWith: string;
  readonly route: JsonValue;
  readonly invocationId: string;
  readonly preflight?: "sandbox" | "validation";
  readonly interaction?: RequiredInteraction;
}

export interface ObserveModelRequest {
  readonly model?: ModelDirective;
  readonly prefix: PromptPrefixSnapshot;
  readonly instructions: readonly string[];
  readonly context: readonly ContextItem[];
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  readonly transcript: readonly TranscriptEntry[];
  readonly tools: readonly ObserveToolSnapshot[];
}

export type ObserveEvent =
  | { readonly type: "session.stopped"; readonly reason: string }
  | { readonly type: "input.received"; readonly inputId: string; readonly kind: string }
  | { readonly type: "input.queued"; readonly inputId: string }
  | { readonly type: "input.rejected"; readonly inputId: string; readonly reason: string }
  | { readonly type: "input.cancelled"; readonly inputId: string; readonly reason: string }
  | {
      readonly type: "model.prefix";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly attributes: {
        readonly status: "initial" | "unchanged" | "declared-change" | "drift";
        readonly snapshot: PromptPrefixSnapshot;
        readonly previous?: PromptPrefixSnapshot;
      };
    }
  | {
      readonly type: "model.started";
      readonly turnId: string;
      readonly stepId: string;
      readonly inputId?: string;
      readonly requestedModelId?: string;
      readonly attributes: ObserveModelRequest;
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
