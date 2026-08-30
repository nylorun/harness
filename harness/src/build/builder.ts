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

export function Agent(model: ModelAdapter): AgentBuilder {
  return new AgentBuilder(model);
}

export class AgentBuilder {
  private readonly middleware: BoundMiddleware[] = [];
  private sealed = false;
  private agent?: BuiltAgent;
  private error?: AgentBuildError;
  private middlewareSeq = 0;

  constructor(private readonly invoke: ModelAdapter) {}

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

  build(): BuiltAgent {
    if (this.agent) return this.agent;
    if (this.error) throw this.error;
    this.sealed = true;
    const result = assembleAgent(this.middleware, this.invoke);
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
