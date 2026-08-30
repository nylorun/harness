import type { ModelCall, ModelCandidate } from "./model.js";
import type { JsonObject, JsonValue, Observer, Tripwire } from "./shared.js";
import type { RequiredInteraction, ToolExecutionResume, ToolOwner, ToolResult } from "./tool.js";

export type InputEvent =
  | { readonly kind: "user-message"; readonly text: string; readonly metadata?: JsonObject }
  | { readonly kind: "interrupt"; readonly text: string; readonly metadata?: JsonObject }
  | { readonly kind: "approve"; readonly interactionId: string; readonly approved: boolean }
  | { readonly kind: "respond"; readonly interactionId: string; readonly value: JsonValue };

export type SessionEvent =
  | { readonly type: "input"; readonly event: InputEvent; readonly turnId: string }
  | {
      readonly type: "candidate";
      readonly turnId: string;
      readonly stepId: string;
      readonly candidate: ModelCandidate;
    }
  | { readonly type: "final"; readonly output: string; readonly turnId: string }
  | {
      readonly type: "interaction.required";
      readonly interaction: RequiredInteraction;
      readonly turnId: string;
    }
  | { readonly type: "tripwire"; readonly tripwire: Tripwire; readonly turnId: string }
  | {
      readonly type: "execution.deferred";
      readonly active: ActiveExecutionRecord;
      readonly turnId: string;
    }
  | { readonly type: "input.queued"; readonly inputId: string }
  | { readonly type: "input.rejected"; readonly inputId: string; readonly reason: string }
  | { readonly type: "input.cancelled"; readonly inputId: string; readonly reason: string }
  | { readonly type: "session.stopped"; readonly sessionId: string };

export interface InputCompletion {
  readonly inputId: string;
  readonly status: "completed" | "waiting" | "rejected" | "cancelled" | "stopped";
  readonly events: readonly SessionEvent[];
}

export interface InputHandle {
  readonly inputId: string;
  readonly completed: Promise<InputCompletion>;
}

export interface SessionOptions {
  readonly id?: string;
  readonly userId?: string;
  readonly context?: JsonObject;
  readonly seed?: never;
  readonly recorder?: SessionRecorder;
}

/** Stable host-owned facts available while a capability creates session-local state. */
export interface SessionIdentity {
  readonly id: string;
  readonly userId?: string;
  readonly context?: JsonObject;
}

export interface SeededSessionOptions {
  readonly seed: SessionSeed;
  readonly recorder?: SessionRecorder;
  readonly id?: never;
  readonly userId?: never;
  readonly context?: never;
}

export type SessionRunOptions = SessionOptions | SeededSessionOptions;

export interface InputOptions {
  readonly signal?: AbortSignal;
}

export type MessageInput = string | { readonly text: string; readonly metadata?: JsonObject };
export type InteractionReply = Extract<InputEvent, { kind: "approve" | "respond" }>;
/** Ordinary user text or an interaction reply. Use `Session.interrupt()` for barge-in text. */
export type SessionInput = MessageInput | InteractionReply;

export interface TranscriptInputEntry {
  readonly kind: "input";
  readonly turnId: string;
  readonly event: InputEvent;
}
export interface TranscriptCandidateEntry {
  readonly kind: "candidate";
  readonly turnId: string;
  readonly stepId: string;
  readonly candidate: ModelCandidate;
}
export interface TranscriptToolsEntry {
  readonly kind: "tool-results";
  readonly turnId: string;
  readonly stepId: string;
  readonly results: readonly ToolResult[];
}
export interface TranscriptFinalEntry {
  readonly kind: "final";
  readonly turnId: string;
  readonly stepId: string;
  readonly output: string;
}
export type TranscriptEntry =
  TranscriptInputEntry | TranscriptCandidateEntry | TranscriptToolsEntry | TranscriptFinalEntry;

export interface SessionSnapshot {
  readonly id: string;
  readonly status: "idle" | "running" | "waiting" | "stopped";
  readonly turnCount: number;
  readonly revision: number;
  readonly transcript: readonly TranscriptEntry[];
  readonly pendingInteraction?: RequiredInteraction;
  readonly active?: ActiveExecutionRecord;
}

export interface SessionSeed {
  readonly id?: string;
  readonly userId?: string;
  readonly context?: JsonObject;
  readonly turnCount?: number;
  readonly revision?: number;
  readonly transcript: readonly TranscriptEntry[];
}

export interface ActiveModelExecutionRecord {
  readonly kind: "model";
  readonly turnId: string;
  readonly stepId: string;
  readonly invocationId: string;
  readonly call: ModelCall;
  readonly token?: JsonValue;
}

export interface ActiveToolCallRecord {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly invocationId: string;
  readonly owner: ToolOwner;
  readonly status: "pending" | "settled" | "deferred";
  readonly result?: ToolResult;
  readonly token?: JsonValue;
}

export interface ActiveToolsExecutionRecord {
  readonly kind: "tools";
  readonly turnId: string;
  readonly stepId: string;
  readonly calls: readonly ActiveToolCallRecord[];
}

export interface ActiveInteractionExecutionRecord {
  readonly kind: "interaction";
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly interaction: RequiredInteraction;
  readonly token?: JsonValue;
  readonly resume?: ToolExecutionResume;
  readonly tools: ActiveToolsExecutionRecord;
}

export type ActiveExecutionRecord =
  ActiveModelExecutionRecord | ActiveToolsExecutionRecord | ActiveInteractionExecutionRecord;

export interface SessionRecord {
  readonly version: 1;
  readonly revision: number;
  readonly transition:
    "input" | "model-requested" | "candidate" | "tool-results" | "waiting" | "final" | "stopped";
  readonly session: {
    readonly id: string;
    readonly userId?: string;
    readonly context?: JsonObject;
    readonly turnCount: number;
    readonly status: SessionSnapshot["status"];
  };
  readonly transcript: readonly TranscriptEntry[];
  readonly active?: ActiveExecutionRecord;
}

export interface SessionRecorder {
  record(value: SessionRecord): Promise<void>;
}

export interface Session {
  readonly id: string;
  readonly state: SessionSnapshot;
  input(event: SessionInput, options?: InputOptions): InputHandle;
  interrupt(event: MessageInput, options?: InputOptions): InputHandle;
  continue(options?: InputOptions): InputHandle;
  stream(): AsyncIterable<SessionEvent>;
  observe(listener: Observer): () => void;
  stop(reason?: string): Promise<void>;
}
