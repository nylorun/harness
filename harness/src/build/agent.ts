import type { AgentManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import type { ModelAdapter } from "../types/model.js";
import type { Session, SessionRunOptions } from "../types/session.js";
import { LiveSession } from "../session/session.js";
import { createId } from "../utils/ids.js";
import { HarnessError } from "../errors.js";

export interface LoopAgent {
  readonly middleware: readonly BoundMiddleware[];
  readonly invoke: ModelAdapter;
}

let createBoundAgent: (
  middleware: readonly BoundMiddleware[],
  manifest: AgentManifest,
) => BuiltAgent;

export class BuiltAgent {
  readonly id: string;
  readonly name: string;

  private constructor(
    readonly middleware: readonly BoundMiddleware[],
    readonly manifest: AgentManifest,
  ) {
    this.id = manifest.id;
    this.name = manifest.name;
  }

  static {
    createBoundAgent = (middleware, manifest) => new BuiltAgent(middleware, manifest);
  }

  run(options: SessionRunOptions): Session {
    const seeded = "seed" in options && options.seed !== undefined;
    if (
      seeded &&
      (("id" in options && options.id !== undefined) ||
        ("userId" in options && options.userId !== undefined) ||
        ("context" in options && options.context !== undefined))
    )
      throw new HarnessError(
        "session.invalid-seed",
        "Seeded run options cannot include id, userId, or context outside the seed",
      );
    const id =
      (seeded ? options.seed.id : "id" in options ? options.id : undefined) ?? createId("session");
    return new LiveSession(
      id,
      Object.freeze({ middleware: this.middleware, invoke: options.onModelCall }),
      options,
    );
  }
}

export function bindAgent(
  middleware: readonly BoundMiddleware[],
  manifest: AgentManifest,
): BuiltAgent {
  return createBoundAgent(middleware, manifest);
}
