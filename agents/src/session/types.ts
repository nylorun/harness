export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type ExitReason = "done" | "timeout" | "budget" | "platform_restart" | "sprite_lost" | "error";
export type SessionStatus = "requested" | "starting" | "running" | "paused" | "cancelling" | "completed" | "failed";
export const SESSION_EVENT_TYPES = [
  "session.started",
  "session.episode.started",
  "session.episode.ended",
  "session.interrupted",
  "session.resumed",
  "model.call",
  "harness.message",
  "tool.call.started",
  "tool.call",
  "skill.invocation",
  "session.ended",
  "error"
] as const;
export type SessionEventType = (typeof SESSION_EVENT_TYPES)[number];

/**
 * The platform tool through which every skill activation flows. Reserved: a
 * folder may not declare a tool under this name (SDD-07).
 */
export const SKILL_TOOL_NAME = "load_skill";

export type SessionEvent = Readonly<{
  session: string;
  seq: number;
  ts: string;
  type: SessionEventType;
  payload: Readonly<Record<string, Json>>;
}>;

export type ToolCall = Readonly<{ id: string; name: string; arguments: string }>;

export type ChatMessage =
  | Readonly<{ role: "system" | "user"; content: string }>
  | Readonly<{ role: "assistant"; content: string; toolCalls?: readonly ToolCall[] }>
  | Readonly<{ role: "tool"; toolCallId: string; content: string }>;

export type ProviderUsage = Readonly<{
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  cachedTokens?: number;
}>;

export type ProviderErrorCode =
  | "model_unavailable"
  | "authentication_failed"
  | "rate_limited"
  | "timeout"
  | "provider_error"
  | "protocol_error";

export type ProviderCallEvidence = Readonly<{
  resolvedModel: string;
  gateway?: string;
  gatewayProfile?: string;
  requestId?: string;
  provider?: string;
  attempts: number;
  timeToFirstTokenMs?: number;
  totalLatencyMs: number;
  fallback?: boolean;
}>;

export type ProviderRequest = Readonly<{
  model: string;
  messages: readonly ChatMessage[];
  tools: readonly Pick<ToolRegistration, "name" | "description" | "inputSchema">[];
  maxOutputTokens: number;
}>;

export type ProviderChunk =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "tool-call"; index: number; id?: string; name?: string; arguments?: string }>
  | Readonly<{
      type: "done";
      finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
      usage: ProviderUsage;
      model?: string;
      evidence?: ProviderCallEvidence;
    }>;

export interface ProviderAdapter {
  complete(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderChunk>;
}

export type ToolChunk = Readonly<{
  stream?: "stdout" | "stderr";
  text?: string;
  exitCode?: number;
}>;

export type SessionToolContext = Readonly<{
  sessionId: string;
  toolCallId: string;
  signal: AbortSignal;
}>;

export type JsonSchema = Readonly<{
  type?: "object" | "string" | "number" | "integer" | "boolean" | "array";
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
}>;

export type ToolRegistration = Readonly<{
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: Json, context: SessionToolContext): AsyncIterable<ToolChunk>;
}>;

export interface EventSink {
  append(event: SessionEvent): Promise<void> | void;
}

export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SessionLimits = Readonly<{
  timeoutMs: number;
  maxTokens: number;
  maxTurns: number;
  maxToolResultBytes: number;
}>;

/**
 * The activation-time view of one skill. Structurally a subset of the loader's
 * `SkillDefinition`, so a resolved `AgentConfig` satisfies this without the
 * session engine depending on the definition module.
 */
export type SessionSkill = Readonly<{
  name: string;
  description: string;
  body: string;
}>;

export type SessionDefinition = Readonly<{
  name: string;
  model: string;
  instructions: string;
  skills?: readonly SessionSkill[];
}>;

export type TranscriptEntry =
  | Readonly<{ kind: "input"; content: string }>
  | Readonly<{ kind: "assistant"; content: string; toolCalls: readonly ToolCall[] }>
  | Readonly<{ kind: "tool"; toolCallId: string; content: string }>;

export type SessionState = Readonly<{
  session: string;
  status: SessionStatus;
  seq: number;
  startedAt?: string;
  endedAt?: string;
  exitReason?: ExitReason;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  turns: number;
  transcript: readonly TranscriptEntry[];
}>;

export type CreateSessionOptions = Readonly<{
  sessionId: string;
  definition: SessionDefinition;
  provider: ProviderAdapter;
  tools?: readonly ToolRegistration[];
  sink: EventSink;
  clock?: Clock;
  limits?: Partial<SessionLimits>;
  harnessVersion?: string;
  /** Folded canonical state selected by the host's journaled watermark. */
  resumeFrom?: SessionState;
  episode?: Readonly<{ ordinal: number; fencingEpoch: number }>;
  resumeInterruption?: Readonly<{ reason: string; previousOrdinal?: number }>;
  /** Return true only at a safe point to hand the session to another episode. */
  onSafePoint?: (safePoint: SessionSafePoint) => boolean | Promise<boolean>;
}>;

export type SessionSafePoint = Readonly<{
  session: string;
  seq: number;
  turns: number;
  tokensIn: number;
  tokensOut: number;
  payloadBytes: number;
  reason: "tool_results_committed";
}>;

export type HostSessionEventType =
  | "session.episode.started"
  | "session.episode.ended"
  | "session.interrupted"
  | "session.resumed";

export interface Session {
  start(input: string): Promise<SessionState>;
  resume(): Promise<SessionState>;
  /**
   * Ends the session with an `error` event. `code` names the platform cause
   * (e.g. `secret_resolution_failed`) so hosts can distinguish abort reasons;
   * it defaults to `"aborted"`.
   */
  abort(reason?: string, code?: string): void;
  state(): SessionState;
  events(): AsyncIterable<SessionEvent>;
  safePoints(): AsyncIterable<SessionSafePoint>;
  /** Closed host-only extension point; arbitrary event names are impossible. */
  appendHostEvent(type: HostSessionEventType, payload: Readonly<Record<string, Json>>): Promise<SessionEvent>;
  /** Pairs a committed start whose external outcome cannot be recovered. */
  appendInterruptedToolResult(input: Readonly<{
    tool: string;
    toolCallId: string;
    argsDigest: string;
  }>): Promise<SessionEvent>;
}
