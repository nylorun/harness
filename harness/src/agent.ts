import type { AgentManifest } from "./types/manifest.js";
import type { BoundMiddleware } from "./types/middleware.js";
import type { ModelAdapter, ModelDirective } from "./types/model.js";
import type { Session, SessionOptions } from "./types/session.js";
import type { AdapterRegistry } from "./build/adapters.js";
import { LiveSession } from "./session/session.js";
import type { LoopAgent } from "./step/run.js";
import { createId } from "./utils/ids.js";

let createBoundAgent: (
  middleware: readonly BoundMiddleware[],
  invoke: ModelAdapter,
  adapters: AdapterRegistry,
  manifest: AgentManifest,
  directive?: ModelDirective,
) => BuiltAgent;

export class BuiltAgent {
  readonly #loopAgent: LoopAgent;

  private constructor(
    readonly middleware: readonly BoundMiddleware[],
    invoke: ModelAdapter,
    adapters: AdapterRegistry,
    readonly manifest: AgentManifest,
    directive?: ModelDirective,
  ) {
    this.#loopAgent = Object.freeze({
      middleware,
      invoke,
      adapters,
      ...(directive === undefined ? {} : { directive }),
    });
  }

  static {
    createBoundAgent = (middleware, invoke, adapters, manifest, directive) =>
      new BuiltAgent(middleware, invoke, adapters, manifest, directive);
  }

  run(options: SessionOptions = {}): Session {
    const id = options.id ?? createId("session");
    return new LiveSession(id, this.#loopAgent, options);
  }
}

export function bindAgent(
  middleware: readonly BoundMiddleware[],
  invoke: ModelAdapter,
  adapters: AdapterRegistry,
  manifest: AgentManifest,
  directive?: ModelDirective,
): BuiltAgent {
  return createBoundAgent(middleware, invoke, adapters, manifest, directive);
}
