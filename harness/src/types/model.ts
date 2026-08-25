import type { ContextItem, JsonObject, JsonValue } from "./shared.js";
import type { InputEvent, TranscriptEntry } from "./session.js";
import type { BoundToolDefinition, ToolResult } from "./tool.js";
import { copyJson, copyJsonObject } from "../utils/immutable.js";

export type BoundModelId = string;

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
}

export interface ModelCandidate {
  readonly content?: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly metadata?: JsonObject;
}

export interface ModelRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly modelId: BoundModelId;
  readonly instructions: readonly string[];
  readonly context: readonly ContextItem[];
  readonly transcript: readonly TranscriptEntry[];
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  /** Tools are normalized and immutable by the time a Model sees them. */
  readonly tools: readonly BoundToolDefinition[];
}

export interface ModelInvoker {
  readonly id?: string;
  readonly version?: string;
  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelCandidate | string>;
}

export type ModelRegistryInput = Readonly<Record<string, ModelInvoker>>;

export interface ModelRequestResolver {
  resolve(input: ModelRequest): ModelRequest;
}

export function normalizeCandidate(value: ModelCandidate | string): ModelCandidate {
  if (typeof value === "string") return Object.freeze({ content: value });
  if (!value || typeof value !== "object")
    throw new TypeError("Model candidate must be an object or string");
  if (value.content !== undefined && typeof value.content !== "string")
    throw new TypeError("Model candidate content must be a string");
  if (value.toolCalls !== undefined && !Array.isArray(value.toolCalls))
    throw new TypeError("Model candidate toolCalls must be an array");
  const calls = value.toolCalls?.map((call) =>
    Object.freeze({
      id: call.id,
      name: call.name,
      args: copyJson(call.args as JsonValue),
    }),
  );
  return Object.freeze({
    ...(value.content === undefined ? {} : { content: value.content }),
    ...(calls === undefined ? {} : { toolCalls: Object.freeze(calls) }),
    ...(value.metadata === undefined
      ? {}
      : { metadata: copyJsonObject(value.metadata, "model candidate metadata") }),
  });
}
