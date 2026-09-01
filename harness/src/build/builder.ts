import type {
  BoundMiddleware,
  CapabilityDeclaration,
  CapabilityItems,
  StepMiddleware,
} from "../types/middleware.js";
import type { ModelAdapter } from "../types/model.js";
import type { BuildDiagnostic } from "../types/shared.js";
import { HarnessError } from "../errors.js";
import type { BuiltAgent } from "./agent.js";
import { assembleAgent } from "./assemble.js";

export interface AgentOptions {
  readonly id: string;
  readonly name: string;
  readonly instructions?: string | readonly string[];
}

interface BuilderState {
  readonly id: string;
  readonly name: string;
  readonly middleware: BoundMiddleware[];
  invoke?: ModelAdapter;
  bound: boolean;
  sealed: boolean;
  agent?: BuiltAgent;
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

export function Agent(options: AgentOptions): AgentBuilder {
  return new AgentBuilder(createState(options));
}

export class AgentBuilder {
  constructor(private readonly state: BuilderState) {}

  use(middleware: StepMiddleware): this;
  use(id: string, middleware: StepMiddleware): this;
  use<State>(declaration: CapabilityDeclaration<State>): this;
  use<State>(
    idOrMiddleware: string | StepMiddleware | CapabilityDeclaration<State>,
    middleware?: StepMiddleware,
  ): this {
    if (typeof idOrMiddleware === "function") {
      return this.push({ id: this.nextMiddlewareId(), handle: idOrMiddleware });
    }
    if (typeof idOrMiddleware === "object") return this.push(compileDeclaration(idOrMiddleware));
    return this.push({ id: idOrMiddleware, handle: middleware! });
  }

  with(onModelCall: ModelAdapter): BoundAgentBuilder {
    this.assertOpen("with()");
    this.state.bound = true;
    this.state.invoke = onModelCall;
    return new BoundAgentBuilder(this.state);
  }

  private nextMiddlewareId(): string {
    const taken = new Set(this.state.middleware.map((item) => item.id));
    let id: string;
    do {
      this.state.middlewareSeq += 1;
      id = `middleware-${this.state.middlewareSeq}`;
    } while (taken.has(id));
    return id;
  }

  private push(entry: BoundMiddleware): this {
    this.assertOpen("build()");
    this.state.middleware.push(entry);
    return this;
  }

  private assertOpen(after: "with()" | "build()"): void {
    if (this.state.bound)
      throw new AgentLifecycleError("AgentBuilder cannot be changed after with()");
    if (this.state.sealed)
      throw new AgentLifecycleError(`AgentBuilder cannot be changed after ${after}`);
  }
}

export class BoundAgentBuilder {
  constructor(private readonly state: BuilderState) {}

  build(): BuiltAgent {
    if (this.state.agent) return this.state.agent;
    if (this.state.error) throw this.state.error;
    this.state.sealed = true;
    const result = assembleAgent(this.state.middleware, this.state.invoke as ModelAdapter, {
      id: this.state.id,
      name: this.state.name,
    });
    if (!result.ok) {
      this.state.error = new AgentBuildError(result.diagnostics);
      throw this.state.error;
    }
    this.state.agent = result.agent;
    return this.state.agent;
  }
}

function createState(options: AgentOptions): BuilderState {
  const middleware: BoundMiddleware[] = [];
  if (options.instructions !== undefined) {
    const instructions =
      typeof options.instructions === "string" ? [options.instructions] : options.instructions;
    middleware.push(compileDeclaration({ id: "agent", instructions }));
  }
  return {
    id: options.id,
    name: options.name,
    middleware,
    bound: false,
    sealed: false,
    middlewareSeq: 0,
  };
}

function compileDeclaration<State>(declaration: CapabilityDeclaration<State>): BoundMiddleware {
  const tools = copyItems(declaration.tools, declaration.id);
  const instructions = copyItems(declaration.instructions, declaration.id);
  const model = declaration.model;
  const handle: StepMiddleware = async (request, next) => {
    if (tools) request.configuration.tools.set(tools.slot, tools.items);
    if (instructions) request.configuration.instructions.set(instructions.slot, instructions.items);
    if (model) request.configuration.model.select(model);
    return declaration.middleware ? declaration.middleware(request as never, next) : next();
  };
  return {
    id: declaration.id,
    handle,
    ...(declaration.state === undefined
      ? {}
      : { state: declaration.state as CapabilityDeclaration["state"] }),
  };
}

function copyItems<Item>(
  value: CapabilityItems<Item> | undefined,
  defaultSlot: string,
): Readonly<{ readonly slot: string; readonly items: readonly Item[] }> | undefined {
  if (value === undefined) return undefined;
  if (!("items" in value))
    return Object.freeze({ slot: defaultSlot, items: Object.freeze([...value]) });
  return Object.freeze({ slot: value.slot, items: Object.freeze([...value.items]) });
}
