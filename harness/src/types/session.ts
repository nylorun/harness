import type { ModelCandidate } from "./model.js";
import type { JsonObject, JsonValue, Observer, Tripwire } from "./shared.js";
import type { RequiredInteraction, ToolResult } from "./tool.js";

export type InputEvent =
  | { readonly kind: "user-message"; readonly text: string; readonly metadata?: JsonObject }
  | { readonly kind: "interrupt"; readonly text: string; readonly metadata?: JsonObject }
  | { readonly kind: "approve"; readonly interactionId: string; readonly approved: boolean }
  | { readonly kind: "respond"; readonly interactionId: string; readonly value: JsonValue };

export type SessionEvent =
  | { readonly type: "final"; readonly output: string; readonly turnId: string }
  | {
      readonly type: "interaction.required";
      readonly interaction: RequiredInteraction;
      readonly turnId: string;
    }
  | { readonly type: "tripwire"; readonly tripwire: Tripwire; readonly turnId: string }
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
  consume(): Promise<InputCompletion>;
}

export interface SessionOptions {
  readonly id?: string;
  readonly userId?: string;
  readonly context?: JsonObject;
}

export interface InputOptions {
  readonly signal?: AbortSignal;
}

export type AgentRunInput = string | InputEvent;

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
  readonly transcript: readonly TranscriptEntry[];
  readonly pendingInteraction?: RequiredInteraction;
}

export interface Session {
  readonly id: string;
  readonly state: SessionSnapshot;
  input(event: AgentRunInput, options?: InputOptions): InputHandle;
  stream(): AsyncIterable<SessionEvent>;
  observe(listener: Observer): void;
  stop(reason?: string): Promise<void>;
}
