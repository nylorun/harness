import type {
  BuiltAgent,
  Event,
  InputAccepted,
  JsonObject,
  JsonValue,
  MessageInput,
  Result,
} from "@nylorun/harness";
import type { AgentsApiClient } from "./client.js";
import { AgentsApiError } from "./errors.js";
import type { AgentsApiSseEvent, HistoryResponse } from "./types.js";
import { SESSION_BUSY } from "./types.js";
import type { OpenSessionOptions, SessionHandle } from "../session/handle.js";

export type CloudSessionHandle = SessionHandle & {
  /** Wire §4.5 history handoff snapshot. */
  historySnapshot(): Promise<HistoryResponse>;
  readonly client: AgentsApiClient;
};

export type OpenCloudSessionOptions = OpenSessionOptions & {
  /** Skip PUT /v1/agents/{id} (JWT clients cannot register). Default: register when agent provided. */
  readonly registerAgent?: boolean;
};

/**
 * Map Runtime `info` → wire `user` at the HTTP edge only.
 * Keep SDK parameter name `info` (hard lock).
 */
export function infoToWireUser(info: unknown): JsonObject | undefined {
  if (info === undefined || info === null) return undefined;
  if (typeof info === "object" && !Array.isArray(info))
    return info as JsonObject;
  return { value: info as JsonValue };
}

/** Eager open (tests / callers that await registration). */
export async function openCloudSession(
  client: AgentsApiClient,
  agent: BuiltAgent<any, any>,
  options: OpenCloudSessionOptions = {},
): Promise<CloudSessionHandle> {
  const handle = createLazyCloudSessionHandle(client, agent, options);
  await handle.ensureOpened();
  return handle;
}

/**
 * Sync handle for `Runtime.openSession`: registers/opens on first use so the
 * taught API stays synchronous while Cloud mutations remain async.
 */
export function createLazyCloudSessionHandle(
  client: AgentsApiClient,
  agent: BuiltAgent<any, any>,
  options: OpenCloudSessionOptions = {},
): CloudSessionHandle & { ensureOpened(): Promise<void> } {
  const id = options.id ?? crypto.randomUUID();
  const register = options.registerAgent !== false;
  let opened: Promise<void> | undefined;
  const ensureOpened = () => {
    opened ??= (async () => {
      if (register) {
        // Hard lock: send harness manifest as-is — no invented `model` field.
        await client.registerAgent(
          agent.id,
          agent.toJSON() as unknown as JsonObject,
        );
      }
      await client.openSession(id, {
        agentId: agent.id,
        user: infoToWireUser(options.info),
        state: options.state,
      });
    })();
    return opened;
  };
  const inner = createCloudSessionHandle(client, agent.id, id);
  return {
    id: inner.id,
    agentId: inner.agentId,
    client: inner.client,
    ensureOpened,
    async input(message: MessageInput | string) {
      await ensureOpened();
      return inner.input(message);
    },
    async *stream(opts?: { readonly after?: string }) {
      await ensureOpened();
      yield* inner.stream(opts);
    },
    async history() {
      await ensureOpened();
      return inner.history();
    },
    async historySnapshot() {
      await ensureOpened();
      return inner.historySnapshot();
    },
    async approve(interactionId: string, approved: boolean) {
      await ensureOpened();
      return inner.approve(interactionId, approved);
    },
    async respond(interactionId: string, value: JsonValue) {
      await ensureOpened();
      return inner.respond(interactionId, value);
    },
    async cancel() {
      await ensureOpened();
      return inner.cancel();
    },
  };
}

export function createCloudSessionHandle(
  client: AgentsApiClient,
  agentId: string,
  sessionId: string,
): CloudSessionHandle {
  const handle: CloudSessionHandle = {
    id: sessionId,
    agentId,
    client,
    async input(message: MessageInput | string): Promise<InputAccepted> {
      const text = messageText(message);
      const outcome = await client.postMessage(sessionId, text);
      if (outcome.status === "accepted") {
        return {
          status: "accepted",
          turnId: outcome.turnId,
          cursor: outcome.cursor,
        };
      }
      // Cloud v1.0: busy rejection — never set steered: true.
      return {
        status: "rejected",
        turnId: outcome.turnId,
        error: {
          code: outcome.code,
          message:
            outcome.message ??
            (outcome.code === SESSION_BUSY
              ? "Session has an active turn. Wait for settlement or cancel."
              : `Rejected: ${outcome.code}`),
        },
      };
    },
    async *stream(opts?: { readonly after?: string }): AsyncIterable<Event> {
      try {
        for await (const frame of client.streamEvents(sessionId, {
          after: opts?.after,
        })) {
          const mapped = mapSseEvent(frame, sessionId);
          if (mapped) yield mapped;
        }
      } catch (error) {
        if (error instanceof AgentsApiError && error.isCursorExpired) throw error;
        throw error;
      }
    },
    async history(): Promise<readonly JsonValue[]> {
      const snapshot = await client.getItems(sessionId);
      return snapshot.items as readonly JsonValue[];
    },
    async historySnapshot(): Promise<HistoryResponse> {
      return client.getItems(sessionId);
    },
    async approve(interactionId: string, approved: boolean) {
      const outcome = await client.postAnswer(sessionId, interactionId, approved);
      if (outcome.status === "rejected")
        throw new AgentsApiError(
          outcome.message ?? `Answer rejected: ${outcome.code}`,
          {
            code: outcome.code,
            status: 409,
            turnId: outcome.turnId,
            requestId: outcome.requestId,
            body: outcome,
          },
        );
    },
    async respond(interactionId: string, value: JsonValue) {
      const outcome = await client.postAnswer(sessionId, interactionId, value);
      if (outcome.status === "rejected")
        throw new AgentsApiError(
          outcome.message ?? `Answer rejected: ${outcome.code}`,
          {
            code: outcome.code,
            status: 409,
            turnId: outcome.turnId,
            requestId: outcome.requestId,
            body: outcome,
          },
        );
    },
    async cancel() {
      const outcome = await client.postCancel(sessionId);
      if (outcome.status === "rejected")
        throw new AgentsApiError(
          outcome.message ?? `Cancel rejected: ${outcome.code}`,
          {
            code: outcome.code,
            status: 409,
            turnId: outcome.turnId,
            requestId: outcome.requestId,
            body: outcome,
          },
        );
    },
  };
  return handle;
}

function messageText(message: MessageInput | string): string {
  if (typeof message === "string") return message;
  if ("text" in message && typeof message.text === "string") return message.text;
  if ("content" in message) {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((part) =>
          part &&
          typeof part === "object" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string"
            ? (part as { text: string }).text
            : "",
        )
        .filter(Boolean)
        .join("\n");
  }
  return JSON.stringify(message);
}

function mapSseEvent(
  event: AgentsApiSseEvent,
  sessionId: string,
): Event | undefined {
  const sid = String(event.sessionId ?? sessionId);
  const turnId = String(event.turnId ?? sid);
  const cursor = typeof event.cursor === "string" ? event.cursor : undefined;
  const at =
    typeof event.at === "string" ? event.at : new Date().toISOString();

  switch (event.type) {
    case "turn.started":
      return {
        type: "turn.started",
        cursor: cursor ?? "0",
        at,
        sessionId: sid,
        turnId,
      };
    case "status": {
      const status = event.status;
      if (
        status === "thinking" ||
        status === "calling_tool" ||
        status === "waiting" ||
        status === "requires_action"
      )
        return { type: "status", status, sessionId: sid, turnId };
      return undefined;
    }
    case "text.delta":
      return {
        type: "text.delta",
        text: String(event.text ?? ""),
        sessionId: sid,
        turnId,
      };
    case "tool.started":
    case "tool.progress":
    case "tool.completed":
    case "tool.failed":
      return {
        type: event.type,
        tool: String(event.tool ?? event.name ?? "tool"),
        sessionId: sid,
        turnId,
      };
    case "interaction.required": {
      const mapped: Event = {
        type: "interaction.required",
        id: String(event.id ?? ""),
        prompt: String(event.prompt ?? ""),
        sessionId: sid,
        turnId,
        ...(event.options
          ? {
              options: event.options as unknown as import("@nylorun/harness").JsonObject,
            }
          : {}),
      };
      return mapped;
    }
    case "turn.settled": {
      const result = (event.result ?? {
        status: "completed",
        output: undefined,
      }) as Result;
      return {
        type: "turn.settled",
        result,
        sessionId: sid,
        turnId,
      };
    }
    default:
      return undefined;
  }
}
