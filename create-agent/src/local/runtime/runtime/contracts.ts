import type { JsonObject, JsonValue, RequiredInteraction } from "@nylorun/harness";

export type Json = JsonValue;

export type WireSessionEvent = Readonly<{
  session: string;
  seq: number;
  ts: string;
  type: string;
  payload: Readonly<Record<string, JsonValue>>;
}>;

export type RuntimeSessionStatus = "requested" | "running" | "waiting" | "paused" | "completed" | "failed";

export type RuntimeSessionState = Readonly<{
  session: string;
  status: RuntimeSessionStatus;
  seq: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  output: string;
  pendingInteraction?: RequiredInteraction;
}>;

export type ChatMessage =
  | Readonly<{ role: "system" | "user"; content: string }>
  | Readonly<{ role: "assistant"; content: string; toolCalls?: readonly ModelToolCall[] }>
  | Readonly<{ role: "tool"; toolCallId: string; content: string }>;

export type ModelToolCall = Readonly<{ id: string; name: string; arguments: string }>;

export type ModelGatewayUsage = Readonly<{
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  cachedTokens?: number;
}>;

export type ModelGatewayCallEvidence = Readonly<{
  resolvedModel: string;
  gateway?: string;
  gatewayProfile?: string;
  requestId?: string;
  provider?: string;
  accessMode?: string;
  protocol?: string;
  capabilities?: Readonly<{ portableHistory: true; providerState: false; hostedTools: false }>;
  attempts: number;
  timeToFirstTokenMs?: number;
  totalLatencyMs: number;
  fallback?: boolean;
}>;

export type ModelGatewayRequest = Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  tools: readonly Readonly<{ name: string; description?: string; inputSchema: JsonObject }>[];
  maxOutputTokens: number;
}>;

export type ModelGatewayChunk =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "tool-call"; index: number; id?: string; name?: string; arguments?: string }>
  | Readonly<{
      type: "done";
      finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
      usage: ModelGatewayUsage;
      model?: string;
      evidence?: ModelGatewayCallEvidence;
    }>;

export interface ModelGatewayAdapter {
  complete(request: ModelGatewayRequest, signal: AbortSignal): AsyncIterable<ModelGatewayChunk>;
}

export type ModelGatewayErrorCode =
  | "model_unavailable"
  | "authentication_failed"
  | "rate_limited"
  | "timeout"
  | "provider_error"
  | "protocol_error";

export type ModelGatewayErrorOptions = Readonly<{
  code: ModelGatewayErrorCode;
  retryable?: boolean;
  status?: number;
  cause?: unknown;
}>;

export class ModelGatewayError extends Error {
  readonly code: ModelGatewayErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: ModelGatewayErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ModelGatewayError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}
