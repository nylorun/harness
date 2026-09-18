import { isHarnessError } from "@nylorun/harness";
import type {
  BuiltAgent,
  ExecutionInput,
  ModelAdapter,
  RunResult,
} from "@nylorun/harness";
import { scrub } from "../redact.js";
import type {
  CanonicalEvent,
  SessionStore,
  StoredSession,
  SessionSummary,
} from "./store.js";

export interface SubmitOptions {
  readonly runId?: string;
  readonly info?: unknown;
  readonly signal?: AbortSignal;
  readonly onModelCall: ModelAdapter;
  readonly secrets?: readonly string[];
  readonly onEvent?: (event: CanonicalEvent) => void;
  readonly started?: Record<string, unknown>;
}

/** The built-in single-process coordinator. Storage adapters do not implement execution. */
export class SessionHost {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, AbortController>();
  private readonly listeners = new Map<
    string,
    Set<(event: CanonicalEvent) => void>
  >();
  private closed = false;
  constructor(readonly store: SessionStore) {}
  private key(agentId: string, sessionId: string) {
    return JSON.stringify([agentId, sessionId]);
  }

  async read(
    agentId: string,
    sessionId: string,
  ): Promise<StoredSession | undefined> {
    const document = await this.store.get(agentId, sessionId);
    if (document?.active && !this.active.has(this.key(agentId, sessionId)))
      return { ...document, status: "interrupted" };
    return document;
  }

  async list(agentId: string): Promise<readonly SessionSummary[]> {
    return (await this.store.list(agentId)).map((session) =>
      session.status === "running" &&
      !this.active.has(this.key(agentId, session.session))
        ? { ...session, status: "interrupted" as const }
        : session,
    );
  }

  subscribe(
    agentId: string,
    sessionId: string,
    listener: (event: CanonicalEvent) => void,
  ): () => void {
    const key = this.key(agentId, sessionId);
    let listeners = this.listeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(key, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) this.listeners.delete(key);
    };
  }

  submit(
    agent: BuiltAgent<any, any>,
    sessionId: string,
    input: ExecutionInput,
    options: SubmitOptions,
  ): Promise<RunResult<any>> {
    const key = this.key(agent.id, sessionId);
    const generation = this.generations.get(key) ?? 0;
    const prior = this.queues.get(key) ?? Promise.resolve();
    const work = prior
      .catch(() => {})
      .then(async () => {
        if ((this.generations.get(key) ?? 0) !== generation)
          throw new Error("Queued input cancelled by interruption");
        if (this.closed) throw new Error("Runtime is closed");
        options.signal?.throwIfAborted();
        const stored = await this.store.get(agent.id, sessionId);
        // Cancellation/shutdown can arrive while an asynchronous store is loading.
        if ((this.generations.get(key) ?? 0) !== generation)
          throw new Error("Queued input cancelled by interruption");
        if (this.closed) throw new Error("Runtime is closed");
        options.signal?.throwIfAborted();
        if (
          stored?.active ||
          stored?.status === "interrupted" ||
          stored?.status === "archived"
        )
          throw new Error(
            "This session is interrupted or archived. Reconcile external effects or start a new session.",
          );
        const controller = new AbortController();
        this.active.set(key, controller);
        const abort = () => controller.abort(options.signal?.reason);
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) abort();
        const now = Date.now();
        const runId = options.runId ?? crypto.randomUUID();
        let document: StoredSession = stored ?? {
          version: 1,
          id: sessionId,
          agentId: agent.id,
          status: "running",
          startedAt: now,
          updatedAt: now,
          events: [],
        };
        const title =
          typeof input === "string"
            ? input
            : "text" in input
              ? input.text
              : "content" in input
                ? input.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join(" ")
                : undefined;
        const events = [...document.events];
        let sequence = events.at(-1)?.seq ?? 0;
        const add = (
          type: string,
          payload: Record<string, unknown>,
          publish = true,
        ) => {
          const event: CanonicalEvent = {
            session: sessionId,
            seq: ++sequence,
            ts: new Date().toISOString(),
            type,
            payload: scrub(
              { ...payload, runId },
              options.secrets ?? [],
            ) as Record<string, unknown>,
          };
          events.push(event);
          if (publish) publishEvent(event);
          return event;
        };
        const publishEvent = (event: CanonicalEvent) => {
          for (const listener of [
            options.onEvent,
            ...(this.listeners.get(key) ?? []),
          ]) {
            try {
              listener?.(event);
            } catch {
              /* Delivery cannot acknowledge or block persistence. */
            }
          }
        };
        const save = async () => {
          document = {
            ...document,
            updatedAt: Date.now(),
            events: [...events],
          };
          await this.store.put(agent.id, sessionId, document);
        };
        try {
          document = {
            ...document,
            status: "running",
            active: { runId, input },
            ...(document.title === undefined && title
              ? { title: title.slice(0, 120) }
              : {}),
          };
          add(
            "session.run.started",
            options.started ?? {
              input_kind:
                typeof input === "string"
                  ? "user-message"
                  : "kind" in input
                    ? input.kind
                    : "user-message",
              ...(typeof input === "string" ? { input } : {}),
            },
          );
          await save();
          const result = await agent.run({
            state: document.state,
            input,
            info: options.info,
            signal: controller.signal,
            onModelCall: options.onModelCall,
            onEvent: (event) => {
              add(event.type, event);
            },
            record: async (state) => {
              document = { ...document, state };
              await save();
            },
          });
          const { active: _, ...rest } = document;
          document = {
            ...rest,
            state: result.state,
            status: result.status === "paused" ? "waiting" : result.status,
          };
          const terminal =
            result.status === "completed"
              ? add("final", { output: result.output }, false)
              : result.status === "paused"
                ? add(
                    "interaction.required",
                    {
                      pending: result.pending,
                      ...(result.pending.find((item) => item.interaction)
                        ?.interaction
                        ? {
                            interaction: result.pending.find(
                              (item) => item.interaction,
                            )!.interaction,
                          }
                        : {}),
                    },
                    false,
                  )
                : add(
                    result.status === "failed" ? "error" : "cancelled",
                    result.status === "failed" ? { ...result.error } : {},
                    false,
                  );
          await save();
          publishEvent(terminal);
          return result;
        } catch (error) {
          if (
            isHarnessError(error) &&
            [
              "execution.invalid-input",
              "execution.invalid-state",
              "execution.incompatible",
            ].includes(error.code)
          ) {
            // Keep the prior continuation, but commit the rejected attempt so event
            // sequence numbers already observed by subscribers are never reused.
            const rejected = add(
              "error",
              {
                message: error instanceof Error ? error.message : String(error),
              },
              false,
            );
            const { active: _, ...rest } = document;
            await this.store.put(agent.id, sessionId, {
              ...(stored ?? { ...rest, status: "failed" as const }),
              updatedAt: Date.now(),
              events: [...events],
            });
            publishEvent(rejected);
            throw error;
          }
          // A failed commit must leave the durable active marker intact. Never replay it.
          add("error", {
            message: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          options.signal?.removeEventListener("abort", abort);
          this.active.delete(key);
        }
      });
    this.queues.set(key, work);
    void work
      .finally(() => {
        if (this.queues.get(key) === work) this.queues.delete(key);
      })
      .catch(() => {});
    return work;
  }

  async cancel(agent: BuiltAgent<any, any>, sessionId: string): Promise<void> {
    const key = this.key(agent.id, sessionId);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.active.get(key)?.abort(new Error("Run cancelled"));
    const prior = this.queues.get(key) ?? Promise.resolve();
    const work = prior
      .catch(() => {})
      .then(async () => {
        const stored = await this.store.get(agent.id, sessionId);
        if (stored?.active || stored?.status === "interrupted")
          throw new Error(
            "This session was interrupted; reconcile its external effects before cancellation.",
          );
        if (stored?.state?.status !== "paused") return;
        const result = await agent.run({
          state: stored.state,
          input: { kind: "continue" },
          signal: AbortSignal.abort(new Error("Paused execution cancelled")),
          onModelCall: async () => {
            throw new Error("Cancelled execution cannot call a model");
          },
        });
        const event: CanonicalEvent = {
          session: sessionId,
          seq: (stored.events.at(-1)?.seq ?? 0) + 1,
          ts: new Date().toISOString(),
          type: "cancelled",
          payload: { executionId: result.state.executionId },
        };
        await this.store.put(agent.id, sessionId, {
          ...stored,
          state: result.state,
          status: "cancelled",
          updatedAt: Date.now(),
          events: [...stored.events, event],
        });
        for (const listener of this.listeners.get(key) ?? []) {
          try {
            listener(event);
          } catch {
            /* Observation cannot change committed cancellation. */
          }
        }
      });
    this.queues.set(key, work);
    try {
      await work;
    } finally {
      if (this.queues.get(key) === work) this.queues.delete(key);
    }
  }

  async interrupt(
    agent: BuiltAgent<any, any>,
    sessionId: string,
    input: ExecutionInput,
    options: SubmitOptions,
  ): Promise<RunResult<any>> {
    await this.cancel(agent, sessionId);
    return this.submit(agent, sessionId, input, options);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const controller of this.active.values())
      controller.abort(new Error("Runtime closing"));
    await Promise.allSettled(this.queues.values());
    this.listeners.clear();
    if ("close" in this.store && typeof this.store.close === "function")
      await this.store.close();
  }
}
