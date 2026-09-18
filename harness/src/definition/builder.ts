import type { BoundMiddleware } from "./bound.js";
import type { CapabilityDeclaration, StepMiddleware } from "../types/middleware.js";
import type { BuildDiagnostic } from "../types/shared.js";
import { HarnessError } from "../errors.js";
import type { ToolSchemaSource, SchemaOutput } from "../types/tool.js";
import type { BuiltAgent } from "../types/agent.js";
import { execute } from "../execution/run.js";
import { assembleAgent } from "./assemble.js";
import { compileDeclaration } from "./declaration.js";

export interface AgentOptions<Schema extends ToolSchemaSource | undefined = undefined> {
  readonly outputSchema?: Schema;
  readonly id: string;
  readonly name: string;
  readonly instructions?: string | readonly string[];
}

interface BuilderState {
  readonly id: string;
  readonly name: string;
  readonly middleware: BoundMiddleware[];
  readonly outputSchema?: ToolSchemaSource;
  sealed: boolean;
  agent?: BuiltAgent<any, any>;
  error?: AgentBuildError;
  middlewareSeq: number;
}

export class AgentBuildError extends HarnessError {
  constructor(readonly diagnostics: readonly BuildDiagnostic[]) {
    super(
      "agent.build-failed",
      diagnostics.map((item) => item.message).join("; ") || "Agent build failed",
    );
    this.name = "AgentBuildError";
  }
}

export class AgentLifecycleError extends HarnessError {
  constructor(message: string) {
    super("agent.lifecycle-sealed", message);
    this.name = "AgentLifecycleError";
  }
}

export function Agent<Info = unknown, Schema extends ToolSchemaSource | undefined = undefined>(
  options: AgentOptions<Schema>,
): AgentBuilder<Info, Schema> {
  return new AgentBuilder(options);
}

export class AgentBuilder<Info = unknown, Schema extends ToolSchemaSource | undefined = undefined> {
  readonly #state: BuilderState;

  constructor(options: AgentOptions<Schema>) {
    this.#state = createState(options);
  }

  use(middleware: StepMiddleware<Info>): this;
  use(id: string, middleware: StepMiddleware<Info>): this;
  use(declaration: CapabilityDeclaration<Info>): this;
  use(
    idOrMiddleware: string | StepMiddleware<Info> | CapabilityDeclaration<Info>,
    middleware?: StepMiddleware<Info>,
  ): this {
    if (typeof idOrMiddleware === "function") {
      return this.push({
        id: this.nextMiddlewareId(),
        handle: idOrMiddleware as StepMiddleware,
        hasMiddleware: true,
      });
    }
    if (typeof idOrMiddleware === "object") return this.push(compileDeclaration(idOrMiddleware));
    return this.push({
      id: idOrMiddleware,
      handle: middleware! as StepMiddleware,
      hasMiddleware: true,
    });
  }

  build(): BuiltAgent<Info, Schema extends ToolSchemaSource ? SchemaOutput<Schema> : string> {
    if (this.#state.agent) return this.#state.agent;
    if (this.#state.error) throw this.#state.error;
    this.#state.sealed = true;
    const result = assembleAgent(
      this.#state.middleware,
      {
        id: this.#state.id,
        name: this.#state.name,
        outputSchema: this.#state.outputSchema,
      },
      execute,
    );
    if (!result.ok) {
      this.#state.error = new AgentBuildError(result.diagnostics);
      throw this.#state.error;
    }
    this.#state.agent = result.agent;
    return this.#state.agent;
  }

  private nextMiddlewareId(): string {
    const taken = new Set(this.#state.middleware.map((item) => item.id));
    let id: string;
    do {
      this.#state.middlewareSeq += 1;
      id = `middleware-${this.#state.middlewareSeq}`;
    } while (taken.has(id));
    return id;
  }

  private push(entry: BoundMiddleware): this {
    this.assertOpen();
    this.#state.middleware.push(entry);
    return this;
  }

  private assertOpen(): void {
    if (this.#state.sealed)
      throw new AgentLifecycleError("AgentBuilder cannot be changed after build()");
  }
}

function createState(options: AgentOptions<ToolSchemaSource | undefined>): BuilderState {
  const middleware: BoundMiddleware[] = [];
  if (options.instructions !== undefined) {
    const instructions =
      typeof options.instructions === "string" ? [options.instructions] : options.instructions;
    middleware.push(compileDeclaration({ id: "agent", instructions }));
  }
  return {
    id: options.id,
    outputSchema: options.outputSchema,
    name: options.name,
    middleware,
    sealed: false,
    middlewareSeq: 0,
  };
}
