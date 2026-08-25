import type { BuildResult, Capability } from "./types/capability.js";
import type { Agent } from "./agent.js";
import { HarnessLifecycleError } from "./errors.js";
import { assembleAgent, type HarnessOptions } from "./build/assemble.js";

export type { HarnessOptions };

export class Harness {
  private readonly capabilities: Capability[] = [];
  private buildPromise?: Promise<BuildResult<Agent>>;

  constructor(private readonly options: HarnessOptions) {}

  add(capability: Capability): this {
    if (this.buildPromise)
      throw new HarnessLifecycleError("Harness cannot be changed after build() starts");
    this.capabilities.push(capability);
    return this;
  }

  build(): Promise<BuildResult<Agent>> {
    this.buildPromise ??= assembleAgent(
      Object.freeze(this.capabilities.map(snapshotCapability)),
      this.options,
    );
    return this.buildPromise;
  }
}

function snapshotCapability(capability: Capability): Capability {
  const originalSetup = capability.setup;
  const snapshot: Capability = {
    id: capability.id,
    ...(capability.version === undefined ? {} : { version: capability.version }),
    ...(capability.middleware === undefined
      ? {}
      : {
          middleware: Object.freeze(
            capability.middleware.map((item) => Object.freeze({ ...item })),
          ),
        }),
    ...(originalSetup === undefined
      ? {}
      : {
          setup(context) {
            return originalSetup.call(snapshot, context);
          },
        }),
  };
  return Object.freeze(snapshot);
}
