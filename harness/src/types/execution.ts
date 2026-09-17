import type { ModelAdapter } from "./model.js";
import type { InputEvent, MessageInput, TranscriptEntry } from "./transcript.js";
import type { ObserveEvent } from "./observe.js";
import type { JsonObject, JsonValue, Tripwire } from "./shared.js";
import type { RequiredInteraction, ToolExecutionResume, ToolOutcome, ToolResult } from "./tool.js";

export type ExecutionInput =
  | MessageInput
  | InputEvent
  | { readonly kind: "continue" }
  | {
      readonly kind: "settle";
      readonly invocationId: string;
      readonly outcome: Extract<ToolOutcome, { kind: "completed" | "failed" | "denied" }>;
    };

/** Portable reference to deployed code. Applications must preserve this value intact. */
export interface ToolReference {
  readonly capabilityId: string;
  readonly toolName: string;
  readonly descriptor: {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: JsonObject;
    readonly outputSchema?: JsonObject;
  };
}

export interface SavedToolCall {
  readonly callId: string;
  readonly invocationId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly rawArgs: JsonValue;
  readonly reference: ToolReference;
  readonly status: "pending" | "active" | "settled" | "interaction" | "deferred";
  readonly result?: ToolResult;
  readonly interaction?: RequiredInteraction;
  readonly interactionPhase?: "before" | "execute";
  readonly resume?: ToolExecutionResume;
  readonly token?: JsonValue;
}

export interface ExecutionPlan {
  readonly turnId: string;
  readonly stepId: string;
  readonly stepNumber: number;
  readonly order: readonly { readonly callId: string; readonly toolName: string }[];
  readonly immediate: readonly ToolResult[];
  readonly calls: readonly SavedToolCall[];
}

/** Versioned continuation data, not a live execution object. */
export interface ExecutionState {
  readonly version: 1;
  readonly agentId: string;
  readonly executionId: string;
  readonly outputContract?: JsonObject;
  readonly revision: number;
  readonly turnCount: number;
  readonly transcript: readonly TranscriptEntry[];
  readonly status: "ready" | "active" | "completed" | "paused" | "cancelled" | "failed";
  readonly plan?: ExecutionPlan;
  /** Abandoned actions retained for reconciliation, never automatically dispatched. */
  readonly cancelledCalls?: readonly SavedToolCall[];
}

export type ExecutionEvent = (
  | ObserveEvent
  | {
      readonly type:
        | "execution.completed"
        | "execution.paused"
        | "execution.cancelled"
        | "execution.failed"
        | "observation.failed";
      readonly attributes?: JsonObject;
    }
) & { readonly executionId: string; readonly sequence: number; readonly runId: string };

export interface RunOptions<Info = unknown> {
  readonly state?: ExecutionState;
  readonly input: ExecutionInput;
  readonly onModelCall: ModelAdapter;
  readonly info?: Info;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: ExecutionEvent) => void | Promise<void>;
  readonly record?: (state: ExecutionState) => void | Promise<void>;
}

export type RunResult<Output = string> =
  | { readonly status: "completed"; readonly state: ExecutionState; readonly output: Output }
  | {
      readonly status: "paused";
      readonly state: ExecutionState;
      readonly pending: readonly SavedToolCall[];
    }
  | { readonly status: "cancelled"; readonly state: ExecutionState }
  | { readonly status: "failed"; readonly state: ExecutionState; readonly error: Tripwire };
