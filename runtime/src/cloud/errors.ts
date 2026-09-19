import {
  CURSOR_EXPIRED,
  RUNTIME_RETIRED,
  SESSION_BUSY,
  type CommandRejected,
} from "./types.js";

export class AgentsApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly turnId?: string;
  readonly requestId?: string;
  readonly body?: unknown;

  constructor(
    message: string,
    options: {
      readonly code: string;
      readonly status: number;
      readonly turnId?: string;
      readonly requestId?: string;
      readonly body?: unknown;
    },
  ) {
    super(message);
    this.name = "AgentsApiError";
    this.code = options.code;
    this.status = options.status;
    this.turnId = options.turnId;
    this.requestId = options.requestId;
    this.body = options.body;
  }

  get isSessionBusy(): boolean {
    return this.code === SESSION_BUSY;
  }

  get isCursorExpired(): boolean {
    return this.code === CURSOR_EXPIRED;
  }

  get isRuntimeRetired(): boolean {
    return this.code === RUNTIME_RETIRED;
  }
}

export function rejectedFromBody(
  body: CommandRejected | Record<string, unknown>,
  status: number,
): AgentsApiError {
  const code =
    typeof body.code === "string" ? body.code : `http_${status}`;
  const message =
    typeof body.message === "string"
      ? body.message
      : `Agents API rejected request (${code})`;
  return new AgentsApiError(message, {
    code,
    status,
    turnId: typeof body.turnId === "string" ? body.turnId : undefined,
    requestId:
      typeof body.requestId === "string" ? body.requestId : undefined,
    body,
  });
}
