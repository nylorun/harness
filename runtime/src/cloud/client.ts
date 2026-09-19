import { AgentsApiError, rejectedFromBody } from "./errors.js";
import {
  newIdempotencyKey,
  newRequestId,
  type CloudConfig,
} from "./config.js";
import { parseSseJsonStream } from "./sse.js";
import type {
  ActionResultCommand,
  AgentsApiSseEvent,
  ClaimActionRequest,
  CommandAccepted,
  CommandOutcome,
  CommandRejected,
  HistoryResponse,
  JsonObject,
  OpenSessionRequest,
  PendingAction,
  RegisterAgentRequest,
  SessionCommand,
} from "./types.js";
import { CURSOR_EXPIRED } from "./types.js";

export type AgentsApiClientOptions = CloudConfig;

export class AgentsApiClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly createRequestId: () => string;
  private readonly createIdempotencyKey: () => string;

  constructor(options: AgentsApiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.credentials.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.createRequestId = options.createRequestId ?? newRequestId;
    this.createIdempotencyKey =
      options.createIdempotencyKey ?? newIdempotencyKey;
  }

  requestId(): string {
    return this.createRequestId();
  }

  idempotencyKey(): string {
    return this.createIdempotencyKey();
  }

  /** PUT /v1/agents/{id} — server key only. */
  async registerAgent(
    id: string,
    manifest: JsonObject,
    requestId = this.requestId(),
  ): Promise<JsonObject> {
    const body: RegisterAgentRequest = { requestId, manifest };
    return this.json("PUT", `/v1/agents/${encodeURIComponent(id)}`, body);
  }

  /** PUT /v1/sessions/{id} — open or create. */
  async openSession(
    id: string,
    request: Omit<OpenSessionRequest, "requestId"> & {
      readonly requestId?: string;
    },
  ): Promise<JsonObject> {
    const body: OpenSessionRequest = {
      requestId: request.requestId ?? this.requestId(),
      ...(request.agentId !== undefined ? { agentId: request.agentId } : {}),
      ...(request.user !== undefined ? { user: request.user } : {}),
      ...(request.state !== undefined ? { state: request.state } : {}),
    };
    return this.json("PUT", `/v1/sessions/${encodeURIComponent(id)}`, body);
  }

  /** POST /v1/sessions/{id}/events */
  async postEvent(
    sessionId: string,
    command: SessionCommand,
  ): Promise<CommandOutcome> {
    const response = await this.raw(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events`,
      command,
    );
    const body = (await readJson(response)) as CommandOutcome | CommandRejected;
    if (
      response.status === 409 ||
      (body &&
        typeof body === "object" &&
        "status" in body &&
        body.status === "rejected")
    ) {
      if (isRejected(body)) return body;
      throw rejectedFromBody(
        {
          status: "rejected",
          code: `http_${response.status}`,
        } satisfies CommandRejected,
        response.status,
      );
    }
    if (!response.ok) {
      throw rejectedFromBody(
        (isRejected(body)
          ? body
          : {
              status: "rejected",
              code: `http_${response.status}`,
              message: response.statusText,
            }) as CommandRejected,
        response.status,
      );
    }
    if (!isAccepted(body))
      throw new AgentsApiError("Unexpected command response", {
        code: "invalid_response",
        status: response.status,
        body,
      });
    return body;
  }

  async postMessage(
    sessionId: string,
    text: string,
    options?: { readonly requestId?: string; readonly idempotencyKey?: string },
  ): Promise<CommandOutcome> {
    return this.postEvent(sessionId, {
      requestId: options?.requestId ?? this.requestId(),
      idempotencyKey: options?.idempotencyKey ?? this.idempotencyKey(),
      type: "message",
      text,
    });
  }

  async postCancel(
    sessionId: string,
    options?: { readonly requestId?: string; readonly idempotencyKey?: string },
  ): Promise<CommandOutcome> {
    return this.postEvent(sessionId, {
      requestId: options?.requestId ?? this.requestId(),
      idempotencyKey: options?.idempotencyKey ?? this.idempotencyKey(),
      type: "cancel",
    });
  }

  async postAnswer(
    sessionId: string,
    interactionId: string,
    value?: unknown,
    options?: { readonly requestId?: string; readonly idempotencyKey?: string },
  ): Promise<CommandOutcome> {
    return this.postEvent(sessionId, {
      requestId: options?.requestId ?? this.requestId(),
      idempotencyKey: options?.idempotencyKey ?? this.idempotencyKey(),
      type: "answer",
      interactionId,
      ...(value === undefined ? {} : { value: value as ActionResultCommand["output"] }),
    });
  }

  async postActionResult(
    sessionId: string,
    result: Omit<ActionResultCommand, "type" | "requestId"> & {
      readonly requestId?: string;
    },
  ): Promise<CommandOutcome> {
    return this.postEvent(sessionId, {
      requestId: result.requestId ?? this.requestId(),
      idempotencyKey: result.idempotencyKey ?? this.idempotencyKey(),
      type: "action_result",
      actionId: result.actionId,
      callId: result.callId,
      ...(result.leaseGeneration !== undefined
        ? { leaseGeneration: result.leaseGeneration }
        : {}),
      ...(result.executorCodeVersion !== undefined
        ? { executorCodeVersion: result.executorCodeVersion }
        : {}),
      ...(result.success !== undefined ? { success: result.success } : {}),
      ...(result.output !== undefined ? { output: result.output } : {}),
    });
  }

  /** GET /v1/sessions/{id}/items */
  async getItems(sessionId: string): Promise<HistoryResponse> {
    const body = await this.json(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/items`,
    );
    if (
      !body ||
      typeof body !== "object" ||
      !Array.isArray((body as HistoryResponse).items) ||
      typeof (body as HistoryResponse).cursor !== "string"
    )
      throw new AgentsApiError("Invalid history response", {
        code: "invalid_response",
        status: 200,
        body,
      });
    return body as HistoryResponse;
  }

  /**
   * GET /v1/sessions/{id}/events?after=… — resumable SSE.
   * Throws AgentsApiError with code cursor_expired on HTTP 410.
   */
  async *streamEvents(
    sessionId: string,
    options?: { readonly after?: string; readonly signal?: AbortSignal },
  ): AsyncGenerator<AgentsApiSseEvent> {
    const query =
      options?.after !== undefined && options.after !== ""
        ? `?after=${encodeURIComponent(options.after)}`
        : "";
    const response = await this.raw(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/events${query}`,
      undefined,
      {
        accept: "text/event-stream",
        signal: options?.signal,
      },
    );
    if (response.status === 410) {
      const body = await readJson(response);
      throw rejectedFromBody(
        {
          status: "rejected",
          code: CURSOR_EXPIRED,
          message:
            body &&
            typeof body === "object" &&
            "message" in body &&
            typeof (body as { message: unknown }).message === "string"
              ? (body as { message: string }).message
              : "Cursor expired; re-fetch history",
        },
        410,
      );
    }
    if (!response.ok) {
      const body = await readJson(response);
      throw rejectedFromBody(
        (body && typeof body === "object"
          ? body
          : {
              status: "rejected",
              code: `http_${response.status}`,
              message: response.statusText,
            }) as CommandRejected,
        response.status,
      );
    }
    const seen = new Set<string>();
    for await (const frame of parseSseJsonStream(
      response.body,
      options?.signal,
    )) {
      if (!frame || typeof frame !== "object") continue;
      const event = frame as AgentsApiSseEvent;
      if (typeof event.cursor === "string") {
        if (seen.has(event.cursor)) continue;
        seen.add(event.cursor);
      }
      yield event;
    }
  }

  /** GET /v1/sessions/{id}/actions — executor. */
  async listActions(sessionId: string): Promise<{
    readonly actions?: readonly PendingAction[];
    readonly [key: string]: unknown;
  }> {
    return this.json(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
    );
  }

  /** POST /v1/actions/{id}/claim */
  async claimAction(
    actionId: string,
    request: ClaimActionRequest = {},
  ): Promise<JsonObject> {
    return this.json(
      "POST",
      `/v1/actions/${encodeURIComponent(actionId)}/claim`,
      {
        requestId: request.requestId ?? this.requestId(),
        ...(request.executorCodeVersion !== undefined
          ? { executorCodeVersion: request.executorCodeVersion }
          : {}),
      },
    );
  }

  /** POST /v1/actions/{id}/heartbeat */
  async heartbeatAction(
    actionId: string,
    body: JsonObject = {},
  ): Promise<JsonObject> {
    return this.json(
      "POST",
      `/v1/actions/${encodeURIComponent(actionId)}/heartbeat`,
      body,
    );
  }

  /** GET /v1/sessions/{id}/export */
  async exportSession(sessionId: string): Promise<JsonObject> {
    return this.json(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/export`,
    );
  }

  private async json(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<JsonObject> {
    const response = await this.raw(method, path, body);
    const parsed = await readJson(response);
    if (!response.ok) {
      throw rejectedFromBody(
        (parsed && typeof parsed === "object"
          ? parsed
          : {
              status: "rejected",
              code: `http_${response.status}`,
              message: response.statusText,
            }) as CommandRejected,
        response.status,
      );
    }
    return (parsed && typeof parsed === "object"
      ? parsed
      : {}) as JsonObject;
  }

  private async raw(
    method: string,
    path: string,
    body?: unknown,
    options?: { readonly accept?: string; readonly signal?: AbortSignal },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: options?.accept ?? "application/json",
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload,
      signal: options?.signal,
    });
  }
}

function isAccepted(value: unknown): value is CommandAccepted {
  return (
    !!value &&
    typeof value === "object" &&
    (value as CommandAccepted).status === "accepted" &&
    typeof (value as CommandAccepted).turnId === "string" &&
    typeof (value as CommandAccepted).cursor === "string" &&
    typeof (value as CommandAccepted).requestId === "string"
  );
}

function isRejected(value: unknown): value is CommandRejected {
  return (
    !!value &&
    typeof value === "object" &&
    (value as CommandRejected).status === "rejected" &&
    typeof (value as CommandRejected).code === "string"
  );
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { message: text };
  }
}
