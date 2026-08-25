import type { CapabilityManifest } from "./types/capability.js";
import type { StepMiddleware } from "./types/middleware.js";
import type { Session, SessionOptions } from "./types/session.js";
import type { BoundToolDefinition } from "./types/tool.js";
import { AgentBuilder, type AgentCreateOptions } from "./builder.js";
import type { AdapterRegistry } from "./build/adapters.js";
import type { ModelRegistry } from "./build/models.js";
import { LiveSession } from "./session/session.js";
import type { LoopAgent } from "./step/run.js";
import { createId } from "./utils/ids.js";
import { createFixedMap } from "./utils/maps.js";

let createBoundAgent: (
  catalog: readonly BoundToolDefinition[],
  instructions: readonly string[],
  middleware: readonly StepMiddleware[],
  models: ModelRegistry,
  adapters: AdapterRegistry,
  manifest: CapabilityManifest,
) => Agent;

export class Agent {
  static create(options: AgentCreateOptions): AgentBuilder {
    return new AgentBuilder(options);
  }

  readonly #loopAgent: LoopAgent;

  private constructor(
    readonly catalog: readonly BoundToolDefinition[],
    readonly instructions: readonly string[],
    readonly middleware: readonly StepMiddleware[],
    models: ModelRegistry,
    adapters: AdapterRegistry,
    readonly manifest: CapabilityManifest,
  ) {
    this.#loopAgent = Object.freeze({
      catalog,
      catalogByName: createFixedMap(catalog.map((tool) => [tool.name, tool] as const)),
      instructions,
      middleware,
      models,
      adapters,
    });
  }

  static {
    createBoundAgent = (catalog, instructions, middleware, models, adapters, manifest) =>
      new Agent(catalog, instructions, middleware, models, adapters, manifest);
  }

  run(options: SessionOptions = {}): Session {
    const id = options.id ?? createId("session");
    return new LiveSession(id, this.#loopAgent, options);
  }
}

export function bindAgent(
  catalog: readonly BoundToolDefinition[],
  instructions: readonly string[],
  middleware: readonly StepMiddleware[],
  models: ModelRegistry,
  adapters: AdapterRegistry,
  manifest: CapabilityManifest,
): Agent {
  return createBoundAgent(catalog, instructions, middleware, models, adapters, manifest);
}
