/**
 * Proposed Agents API wire types (Cloud v1.0).
 * Source: docs/agents-api.openapi.yaml — freeze with Runtime in phase 0.
 */

export type AgentsApiAuthMode = "server_key" | "end_user_jwt" | "executor";

export type JsonObject = Record<string, unknown>;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | JsonObject;

/** Wire spelling uses `user`; Runtime SDK keeps `info` and maps at the HTTP edge. */
export type WireUser = JsonObject;

export type RegisterAgentRequest = {
  readonly requestId: string;
  readonly manifest: JsonObject;
};

export type OpenSessionRequest = {
  readonly requestId: string;
  readonly agentId?: string;
  readonly user?: WireUser;
  readonly state?: JsonObject;
};

export type MessageCommand = {
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly type: "message";
  readonly text: string;
};

export type CancelCommand = {
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly type: "cancel";
};

export type AnswerCommand = {
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly type: "answer";
  readonly interactionId: string;
  readonly value?: JsonValue;
};

export type ActionResultCommand = {
  readonly requestId: string;
  readonly idempotencyKey?: string;
  readonly type: "action_result";
  readonly actionId: string;
  readonly callId: string;
  readonly leaseGeneration?: number;
  readonly executorCodeVersion?: string;
  readonly success?: boolean;
  readonly output?: JsonValue;
};

export type SessionCommand =
  | MessageCommand
  | CancelCommand
  | AnswerCommand
  | ActionResultCommand;

export type CommandAccepted = {
  readonly status: "accepted";
  readonly turnId: string;
  readonly cursor: string;
  readonly requestId: string;
};

export type CommandRejected = {
  readonly status: "rejected";
  readonly code: string;
  readonly turnId?: string;
  readonly message?: string;
  readonly requestId?: string;
};

export type CommandOutcome = CommandAccepted | CommandRejected;

export type HistoryResponse = {
  readonly items: readonly JsonObject[];
  readonly cursor: string;
};

export type ClaimActionRequest = {
  readonly requestId?: string;
  readonly executorCodeVersion?: string;
};

export type PendingAction = {
  readonly type: string;
  readonly actionId: string;
  readonly turnId?: string;
  readonly callId?: string;
  readonly name?: string;
  readonly arguments?: JsonObject;
  readonly user?: WireUser;
  readonly redelivery?: boolean;
  readonly manifestHash?: string;
  readonly protocolVersion?: string;
  readonly [key: string]: unknown;
};

/** Public SSE envelope (illustrative until phase-0 freeze). */
export type AgentsApiSseEvent = {
  readonly type: string;
  readonly cursor?: string;
  readonly at?: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly text?: string;
  readonly tool?: string;
  readonly id?: string;
  readonly prompt?: string;
  readonly options?: JsonObject;
  readonly status?: string;
  readonly result?: JsonValue;
  readonly [key: string]: unknown;
};

export const SESSION_BUSY = "session_busy";
export const RUNTIME_RETIRED = "runtime_retired";
export const CURSOR_EXPIRED = "cursor_expired";
