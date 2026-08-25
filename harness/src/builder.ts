import type { Agent } from "./agent.js";
import type { Capability } from "./types/capability.js";
import { AgentBuildError, AgentLifecycleError } from "./errors.js";
import { assembleAgent, type AgentCreateOptions } from "./build/assemble.js";

export type { AgentCreateOptions };

export class AgentBuilder {
  private readonly capabilities: Capability[] = [];
  private sealed = false;
  private agent?: Agent;
  private error?: AgentBuildError;

  constructor(private readonly options: AgentCreateOptions) {}

  with(capability: Capability): this {
    if (this.sealed) throw new AgentLifecycleError("AgentBuilder cannot be changed after build()");
    this.capabilities.push(capability);
    return this;
  }

  build(): Agent {
    if (this.agent) return this.agent;
    if (this.error) throw this.error;
    this.sealed = true;
    const result = assembleAgent(
      Object.freeze(this.capabilities.map(snapshotCapability)),
      this.options,
    );
    if (!result.ok) {
      this.error = new AgentBuildError(result.diagnostics);
      throw this.error;
    }
    this.agent = result.agent;
    return this.agent;
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
