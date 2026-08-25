import type { BuiltAgent } from "./agent.js";
import type { BoundMiddleware, StepMiddleware } from "./types/middleware.js";
import type { ModelInvoker } from "./types/model.js";
import type { ToolAdapter } from "./types/tool.js";
import { AgentBuildError, AgentLifecycleError } from "./errors.js";
import { assembleAgent } from "./build/assemble.js";

export function Agent(model: ModelInvoker): AgentBuilder {
  return new AgentBuilder(model);
}

export class AgentBuilder {
  private readonly middleware: BoundMiddleware[] = [];
  private readonly adapters: ToolAdapter[] = [];
  private sealed = false;
  private agent?: BuiltAgent;
  private error?: AgentBuildError;

  constructor(private readonly model: ModelInvoker) {}

  with(adapter: ToolAdapter): this {
    if (this.sealed) throw new AgentLifecycleError("AgentBuilder cannot be changed after build()");
    this.adapters.push(adapter);
    return this;
  }

  use(id: string, middleware: StepMiddleware): this {
    return this.#push({ id, handle: middleware }, false);
  }

  /** Host injection. Inserts ahead of `.use` so the middleware is outermost. */
  prepend(id: string, middleware: StepMiddleware): this {
    return this.#push({ id, handle: middleware }, true);
  }

  build(): BuiltAgent {
    if (this.agent) return this.agent;
    if (this.error) throw this.error;
    this.sealed = true;
    const result = assembleAgent(
      Object.freeze(this.middleware.map((item) => Object.freeze({ ...item }))),
      this.model,
      Object.freeze(this.adapters.slice()),
    );
    if (!result.ok) {
      this.error = new AgentBuildError(result.diagnostics);
      throw this.error;
    }
    this.agent = result.agent;
    return this.agent;
  }

  #push(entry: BoundMiddleware, front: boolean): this {
    if (this.sealed) throw new AgentLifecycleError("AgentBuilder cannot be changed after build()");
    if (front) this.middleware.unshift(entry);
    else this.middleware.push(entry);
    return this;
  }
}
