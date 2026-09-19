/**
 * Executor surface hooks for Cloud Agents API (wire §3.6 / §6).
 * Full R4 auto-fulfililment, connect() WS loop, and webhook verifier are deferred.
 */

import type { AgentsApiClient } from "./client.js";
import type {
  ActionResultCommand,
  ClaimActionRequest,
  CommandOutcome,
  JsonObject,
  PendingAction,
} from "./types.js";

export type ExecutorSurfaces = {
  listActions(sessionId: string): Promise<{
    readonly actions?: readonly PendingAction[];
    readonly [key: string]: unknown;
  }>;
  claimAction(
    actionId: string,
    request?: ClaimActionRequest,
  ): Promise<JsonObject>;
  heartbeatAction(actionId: string, body?: JsonObject): Promise<JsonObject>;
  postActionResult(
    sessionId: string,
    result: Omit<ActionResultCommand, "type" | "requestId"> & {
      readonly requestId?: string;
    },
  ): Promise<CommandOutcome>;
};

export function createExecutorSurfaces(
  client: AgentsApiClient,
): ExecutorSurfaces {
  return {
    listActions: (sessionId) => client.listActions(sessionId),
    claimAction: (actionId, request) => client.claimAction(actionId, request),
    heartbeatAction: (actionId, body) =>
      client.heartbeatAction(actionId, body ?? {}),
    postActionResult: (sessionId, result) =>
      client.postActionResult(sessionId, result),
  };
}

/**
 * Apply tool `effects` policy on redelivery (wire §3.6).
 * Returns whether the SDK should auto-rerun the tool.
 */
export function shouldRerunOnRedelivery(
  effects: string | undefined,
  redelivery: boolean,
): "rerun" | "inspect" {
  if (!redelivery) return "rerun";
  if (effects === "read" || effects === "idempotent") return "rerun";
  return "inspect";
}
