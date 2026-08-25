import type { AgentManifest } from "./types/manifest.js";
import type { BoundMiddleware } from "./types/middleware.js";
import type { ModelInvoker } from "./types/model.js";
import type { Session, SessionOptions } from "./types/session.js";
import type { AdapterRegistry } from "./build/adapters.js";
import { LiveSession } from "./session/session.js";
import type { LoopAgent } from "./step/run.js";
import { createId } from "./utils/ids.js";

let createBoundAgent: (
  middleware: readonly BoundMiddleware[],
  model: ModelInvoker,
  adapters: AdapterRegistry,
  manifest: AgentManifest,
) => BuiltAgent;

export class BuiltAgent {
  readonly #loopAgent: LoopAgent;

  private constructor(
    readonly middleware: readonly BoundMiddleware[],
    model: ModelInvoker,
    adapters: AdapterRegistry,
    readonly manifest: AgentManifest,
  ) {
    this.#loopAgent = Object.freeze({
      middleware,
      model,
      adapters,
    });
  }

  static {
    createBoundAgent = (middleware, model, adapters, manifest) =>
      new BuiltAgent(middleware, model, adapters, manifest);
  }

  run(options: SessionOptions = {}): Session {
    const id = options.id ?? createId("session");
    return new LiveSession(id, this.#loopAgent, options);
  }
}

export function bindAgent(
  middleware: readonly BoundMiddleware[],
  model: ModelInvoker,
  adapters: AdapterRegistry,
  manifest: AgentManifest,
): BuiltAgent {
  return createBoundAgent(middleware, model, adapters, manifest);
}
