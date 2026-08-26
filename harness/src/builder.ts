import type { BuiltAgent } from "./agent.js";
import type { BoundMiddleware, StepMiddleware } from "./types/middleware.js";
import type { ModelAdapter, ModelDirective } from "./types/model.js";
import type { BuildDiagnostic } from "./types/shared.js";
import type { ToolAdapter } from "./types/tool.js";
import { assembleAgent } from "./build/assemble.js";

export class AgentBuildError extends Error {
  constructor(readonly diagnostics: readonly BuildDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join("; ") || "Agent build failed");
    this.name = "AgentBuildError";
  }
}

export class AgentLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLifecycleError";
  }
}

export function Agent(model: ModelAdapter, directive?: ModelDirective): AgentBuilder {
  return new AgentBuilder(model, directive);
}

export class AgentBuilder {
  private readonly middleware: BoundMiddleware[] = [];
  private readonly adapters: ToolAdapter[] = [];
  private sealed = false;
  private agent?: BuiltAgent;
  private error?: AgentBuildError;
  private middlewareSeq = 0;

  constructor(
    private readonly invoke: ModelAdapter,
    private readonly directive?: ModelDirective,
  ) {}

  with(adapter: ToolAdapter): this {
    if (this.sealed) throw new AgentLifecycleError("AgentBuilder cannot be changed after build()");
    this.adapters.push(adapter);
    return this;
  }

  use(middleware: StepMiddleware): this;
  use(id: string, middleware: StepMiddleware): this;
  use(idOrMiddleware: string | StepMiddleware, middleware?: StepMiddleware): this {
    if (typeof idOrMiddleware === "function") {
      return this.push({ id: this.nextMiddlewareId(), handle: idOrMiddleware });
    }
    return this.push({ id: idOrMiddleware, handle: middleware! });
  }

  build(): BuiltAgent {
    if (this.agent) return this.agent;
    if (this.error) throw this.error;
    this.sealed = true;
    const result = assembleAgent(this.middleware, this.invoke, this.adapters, this.directive);
    if (!result.ok) {
      this.error = new AgentBuildError(result.diagnostics);
      throw this.error;
    }
    this.agent = result.agent;
    return this.agent;
  }

  private nextMiddlewareId(): string {
    const taken = new Set(this.middleware.map((item) => item.id));
    let id: string;
    do {
      this.middlewareSeq += 1;
      id = `middleware-${this.middlewareSeq}`;
    } while (taken.has(id));
    return id;
  }

  private push(entry: BoundMiddleware): this {
    if (this.sealed) throw new AgentLifecycleError("AgentBuilder cannot be changed after build()");
    this.middleware.push(entry);
    return this;
  }
}
