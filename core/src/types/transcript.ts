import type { ModelCandidate } from "./model.js";
import type { JsonObject, JsonValue } from "./shared.js";
import type { ToolResult } from "./tool.js";

export type InputEvent =
  | {
      readonly kind: "user-message" | "interrupt";
      readonly text: string;
      readonly metadata?: JsonObject;
    }
  | {
      readonly kind: "user-message" | "interrupt";
      readonly content: readonly UserContentPart[];
      /** Undefined for content-bearing events; retained for text-event narrowing compatibility. */
      readonly text?: undefined;
      readonly metadata?: JsonObject;
    }
  | {
      readonly kind: "approve";
      readonly interactionId: string;
      readonly approved: boolean;
    }
  | {
      readonly kind: "respond";
      readonly interactionId: string;
      readonly value: JsonValue;
    };

/** Ordered, model-visible user content. Media references stay host-owned JSON values. */
export type UserContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "media";
      readonly mediaType: string;
      readonly reference: JsonValue;
    };

export type MessageInput =
  | string
  | { readonly text: string; readonly metadata?: JsonObject }
  | {
      readonly content: readonly UserContentPart[];
      readonly metadata?: JsonObject;
    };
export type InteractionReply = Extract<
  InputEvent,
  { kind: "approve" | "respond" }
>;
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
  readonly output: JsonValue;
}
export type TranscriptEntry =
  | TranscriptInputEntry
  | TranscriptCandidateEntry
  | TranscriptToolsEntry
  | TranscriptFinalEntry;
