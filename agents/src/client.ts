import type {
  AgentManifest,
  BuiltAgent,
  JsonValue,
} from "@nylorun/harness/define";
import {
  LiveEventSchema,
  SessionItemsResponseSchema,
  type AcceptedResponse,
  type SessionCommand,
} from "@nylorun/harness/contracts";
import { Transport, id, segment, type Destination } from "./http.js";
import { observeSSE } from "./sse.js";
export interface AgentSource {
  readonly id: string;
  readonly manifest: AgentManifest;
  readonly hash: string;
  build?(): BuiltAgent;
}
export interface SessionView {
  id: string;
  agentId: string;
  ownerUserId: string;
  status: string;
  activeTurnId: string | null;
  [key: string]: unknown;
}
export class AgentsClient {
  readonly transport: Transport;
  constructor(destination: Destination = {}) {
    this.transport = new Transport(destination);
  }
  saveAgent(
    agent: AgentSource,
    options: { implementationVersion: string; requestId?: string }
  ) {
    return this.transport.json(`/v1/agents/${segment(agent.id)}`, "PUT", {
      requestId: options.requestId ?? id(),
      manifest: agent.manifest,
      implementationVersion: options.implementationVersion,
    });
  }
  async createSession(options: {
    id?: string;
    agentId: string;
    ownerUserId: string;
    info?: Record<string, unknown>;
    requestId?: string;
  }): Promise<SessionClient> {
    const sessionId = options.id ?? id();
    await this.transport.json(`/v1/sessions/${segment(sessionId)}`, "PUT", {
      requestId: options.requestId ?? id(),
      agentId: options.agentId,
      ownerUserId: options.ownerUserId,
      ...(options.info ? { info: options.info } : {}),
    });
    return this.session(sessionId);
  }
  session(sessionId: string): SessionClient {
    return new SessionClient(this.transport, sessionId);
  }
}
export type CommandOptions = {
  idempotencyKey: string;
  requestId?: string;
  signal?: AbortSignal;
};
export class SessionClient {
  constructor(private readonly transport: Transport, readonly id: string) {}
  private get path() {
    return `/v1/sessions/${segment(this.id)}`;
  }
  inspect(signal?: AbortSignal) {
    return this.transport.json<SessionView>(
      this.path,
      "GET",
      undefined,
      signal
    );
  }
  command(command: SessionCommand, signal?: AbortSignal) {
    return this.transport.json<AcceptedResponse>(
      `${this.path}/commands`,
      "POST",
      command,
      signal
    );
  }
  input(content: string, options: CommandOptions) {
    return this.command(
      {
        type: "message",
        content,
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
      },
      options.signal
    );
  }
  approve(interactionId: string, approved: boolean, options: CommandOptions) {
    return this.command(
      {
        type: "approve",
        interactionId,
        approved,
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
      },
      options.signal
    );
  }
  respond(interactionId: string, value: JsonValue, options: CommandOptions) {
    return this.command(
      {
        type: "respond",
        interactionId,
        value,
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
      },
      options.signal
    );
  }
  cancel(options: CommandOptions & { reason?: string }) {
    return this.command(
      {
        type: "cancel",
        requestId: options.requestId ?? id(),
        idempotencyKey: options.idempotencyKey,
        ...(options.reason ? { reason: options.reason } : {}),
      },
      options.signal
    );
  }
  async history(options: { cursor?: string; signal?: AbortSignal } = {}) {
    return SessionItemsResponseSchema.parse(
      await this.transport.json(
        `${this.path}/items${
          options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ""
        }`,
        "GET",
        undefined,
        options.signal
      )
    );
  }
  async *observe(options: { cursor?: string; signal?: AbortSignal } = {}) {
    for await (const frame of observeSSE(
      this.transport,
      `${this.path}/events`,
      options
    )) {
      if (frame.event === "heartbeat" || frame.event === "ready") continue;
      yield LiveEventSchema.parse(JSON.parse(frame.data));
    }
  }
}
export function createClient(destination: Destination = {}) {
  return new AgentsClient(destination);
}
