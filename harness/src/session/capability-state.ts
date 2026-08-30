import { HarnessError } from "../errors.js";
import type { BoundMiddleware, CapabilityState } from "../types/middleware.js";
import type { SessionIdentity } from "../types/session.js";
import type { ObserveEmit } from "../utils/observe.js";

interface Entry {
  readonly id: string;
  readonly state: CapabilityState<unknown>;
  promise?: Promise<unknown>;
  created?: boolean;
  value?: unknown;
}

/** Owns declared, process-local state for exactly one Session. */
export class CapabilityStateRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #controller = new AbortController();
  #shutdown?: Promise<void>;

  constructor(
    middleware: readonly BoundMiddleware[],
    private readonly session: SessionIdentity,
    private readonly observe: ObserveEmit,
  ) {
    for (const middlewareEntry of middleware) {
      if (middlewareEntry.state)
        this.#entries.set(middlewareEntry.id, {
          id: middlewareEntry.id,
          state: middlewareEntry.state,
        });
    }
  }

  has(id: string): boolean {
    return this.#entries.has(id);
  }

  get(id: string): Promise<unknown> {
    const entry = this.#entries.get(id);
    if (!entry)
      return Promise.reject(
        new HarnessError(
          "capability.state.undeclared",
          `Capability '${id}' did not declare session state`,
        ),
      );
    if (!entry.promise) {
      entry.promise = Promise.resolve()
        .then(() => entry.state.create(this.session, this.#controller.signal))
        .then(
          (value) => {
            entry.value = value;
            entry.created = true;
            return value;
          },
          (cause) => {
            throw new HarnessError(
              "capability.state.create-failed",
              `Capability '${id}' failed to create session state`,
              { cause },
            );
          },
        );
    }
    return entry.promise;
  }

  abort(reason: unknown): void {
    this.#controller.abort(reason);
  }

  shutdown(reason: unknown): Promise<void> {
    if (this.#shutdown) return this.#shutdown;
    this.abort(reason);
    this.#shutdown = (async () => {
      const created = [...this.#entries.values()].filter((entry) => entry.promise);
      await Promise.allSettled(created.map((entry) => entry.promise!));
      for (const entry of [...created].reverse()) {
        if (!entry.created || !entry.state.dispose) continue;
        try {
          await entry.state.dispose(entry.value);
        } catch (error) {
          this.observe({
            type: "capability.state.dispose.failed",
            capabilityId: entry.id,
            attributes: { message: error instanceof Error ? error.message : String(error) },
          });
        }
      }
    })();
    return this.#shutdown;
  }
}
