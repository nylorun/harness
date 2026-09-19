import type {
  BuiltAgent,
  ExecutionInput,
  InputAccepted,
  JsonObject,
  JsonValue,
  MessageInput,
  ModelAdapter,
  Event,
  Result,
  Session,
} from "@nylorun/harness";
import type { RuntimeConfig } from "../config.js";
import type { CanonicalEvent } from "../sessions/store.js";
import type { SessionHost } from "../sessions/host.js";

export type OpenSessionOptions = {
  readonly id?: string;
  /** Trusted host bag — keep the name `info` (never `user`). */
  readonly info?: unknown;
  /** Initial durable session memory (`ExecutionState.state`). */
  readonly state?: JsonObject;
};

export type SessionHandle<Output = unknown> = Session<
  { readonly id: string },
  Output
> & {
  readonly agentId: string;
};

export type SessionRuntime = {
  readonly host: SessionHost;
  readonly config: RuntimeConfig;
  resolveModel(): ModelAdapter;
};

export function createSessionHandle(
  runtime: SessionRuntime,
  agent: BuiltAgent<any, any>,
  options: OpenSessionOptions = {},
): SessionHandle {
  const id = options.id ?? crypto.randomUUID();
  let seedState = options.state;
  const info = options.info;

  const submitOptions = () => {
    const sessionState = seedState;
    seedState = undefined;
    return {
      info:
        info === undefined
          ? { sessionId: id }
          : { ...(info as object), sessionId: id },
      onModelCall: runtime.resolveModel(),
      ...(sessionState ? { sessionState } : {}),
    };
  };

  const handle: SessionHandle = {
    id,
    agentId: agent.id,
    async input(message: MessageInput | string) {
      try {
        const result = await runtime.host.submit(
          agent,
          id,
          message,
          submitOptions(),
        );
        const cursor = String(
          (await runtime.host.read(agent.id, id))?.events.at(-1)?.seq ?? 0,
        );
        return {
          status: "accepted" as const,
          turnId: result.state.plan?.turnId ?? result.state.executionId,
          cursor,
        } satisfies InputAccepted;
      } catch (error) {
        return {
          status: "rejected" as const,
          error: {
            code:
              error && typeof error === "object" && "code" in error
                ? String((error as { code: unknown }).code)
                : "runtime.input-rejected",
            message: error instanceof Error ? error.message : String(error),
          },
        } satisfies InputAccepted;
      }
    },
    async *stream(opts?: { readonly after?: string }) {
      let after = opts?.after ? Number(opts.after) : 0;
      if (!Number.isFinite(after) || after < 0) after = 0;
      const queue: CanonicalEvent[] = [];
      let notify: (() => void) | undefined;
      const wake = () => {
        notify?.();
        notify = undefined;
      };
      const unsubscribe = runtime.host.subscribe(agent.id, id, (event) => {
        queue.push(event);
        wake();
      });
      try {
        const existing = await runtime.host.read(agent.id, id);
        for (const event of existing?.events ?? [])
          if (event.seq > after) queue.push(event);
        for (;;) {
          while (queue.length) {
            const event = queue.shift()!;
            if (event.seq <= after) continue;
            after = event.seq;
            const mapped = mapEvent(event, id);
            if (mapped) yield mapped;
          }
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      } finally {
        unsubscribe();
      }
    },
    async history() {
      const document = await runtime.host.read(agent.id, id);
      return (document?.events ?? [])
        .filter((event) =>
          ["final", "interaction.required", "error", "cancelled"].includes(
            event.type,
          ),
        )
        .map((event) => event.payload as JsonValue);
    },
    async approve(interactionId: string, approved: boolean) {
      await runtime.host.submit(
        agent,
        id,
        { kind: "approve", interactionId, approved },
        submitOptions(),
      );
    },
    async respond(interactionId: string, value: JsonValue) {
      await runtime.host.submit(
        agent,
        id,
        { kind: "respond", interactionId, value },
        submitOptions(),
      );
    },
    async cancel() {
      await runtime.host.cancel(agent, id);
    },
  };
  return handle;
}

/** Resolve a wait by harness waitId (H6). */
export async function resolveWait(
  runtime: SessionRuntime,
  agent: BuiltAgent<any, any>,
  sessionId: string,
  waitId: string,
  value?: JsonValue,
  options?: { readonly info?: unknown; readonly onModelCall?: ModelAdapter },
): Promise<void> {
  const input: ExecutionInput = {
    kind: "wait-resolve",
    waitId,
    ...(value === undefined ? {} : { value }),
  };
  await runtime.host.submit(agent, sessionId, input, {
    info: options?.info,
    onModelCall: options?.onModelCall ?? runtime.resolveModel(),
  });
}

function mapEvent(event: CanonicalEvent, sessionId: string): Event | undefined {
  const turnId =
    typeof event.payload.turnId === "string"
      ? event.payload.turnId
      : typeof event.payload.executionId === "string"
        ? event.payload.executionId
        : sessionId;
  const cursor = String(event.seq);
  const at = event.ts;
  switch (event.type) {
    case "session.run.started":
      return { type: "turn.started", cursor, at, sessionId, turnId };
    case "tool.started":
      return {
        type: "tool.started",
        tool: String(event.payload.toolName ?? "tool"),
        sessionId,
        turnId,
      };
    case "tool.progress":
      return {
        type: "tool.progress",
        tool: String(event.payload.toolName ?? "tool"),
        sessionId,
        turnId,
      };
    case "tool.completed":
      return {
        type:
          event.payload.outcome === "failed" ? "tool.failed" : "tool.completed",
        tool: String(event.payload.toolName ?? "tool"),
        sessionId,
        turnId,
      };
    case "interaction.required": {
      const interaction = event.payload.interaction as
        | { id?: string; prompt?: string; metadata?: JsonObject }
        | undefined;
      return {
        type: "interaction.required",
        id: String(interaction?.id ?? ""),
        prompt: String(interaction?.prompt ?? ""),
        ...(interaction?.metadata ? { options: interaction.metadata } : {}),
        sessionId,
        turnId,
      };
    }
    case "final":
      return {
        type: "turn.settled",
        result: {
          status: "completed",
          output: event.payload.output,
        } satisfies Result,
        sessionId,
        turnId,
      };
    case "error":
      return {
        type: "turn.settled",
        result: {
          status: "failed",
          error: {
            code: String(event.payload.code ?? "execution.failed"),
            message: String(event.payload.message ?? "failed"),
          },
        } satisfies Result,
        sessionId,
        turnId,
      };
    case "cancelled":
      return {
        type: "turn.settled",
        result: { status: "cancelled" } satisfies Result,
        sessionId,
        turnId,
      };
    default:
      if (event.type === "model.requested" || event.type === "model.completed")
        return {
          type: "status",
          status: "thinking",
          sessionId,
          turnId,
        };
      if (event.type.startsWith("tool."))
        return {
          type: "status",
          status: "calling_tool",
          sessionId,
          turnId,
        };
      return undefined;
  }
}
