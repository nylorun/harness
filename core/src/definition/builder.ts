import type { BoundMiddleware } from "./bound.js";
import type {
  CapabilityInput,
  StepMiddleware,
} from "../types/middleware.js";
import type { BuildDiagnostic, JsonObject } from "../types/shared.js";
import { HarnessError } from "../errors.js";
import type {
  ToolDefinition,
  ToolSchemaSource,
  SchemaOutput,
} from "../types/tool.js";
import type { AgentTool, BuiltAgent } from "../types/agent.js";
import type { AgentManifest } from "../types/manifest.js";
import type {
  AfterHook,
  BeforeHook,
  HookAt,
  HookScope,
} from "../types/dynamics.js";
import type { Implementations } from "./implementations.js";
import { assembleAgent, type CapabilityDynamics } from "./assemble.js";
import { compileDeclaration } from "./declaration.js";
import { agentFrom } from "./from.js";
import { hooksFrom } from "./hooks.js";

export interface AgentOptions<
  Schema extends ToolSchemaSource | undefined = undefined
> {
  readonly outputSchema?: Schema;
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly instructions?: string | readonly string[];
  /** Top-level tools (H2), and agents used as tools. Composed as capability id `"agent"`. */
  readonly tools?: readonly (ToolDefinition<any, any, any> | AgentTool)[];
  // model is intentionally absent — Runtime owns model resolution via onModelCall.
}

interface BuilderSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly metadata?: JsonObject;
  readonly outputSchema?: ToolSchemaSource;
  readonly entries: readonly BoundMiddleware[];
  readonly dynamics: ReadonlyMap<string, CapabilityDynamics>;
  /** Builder-level problems, reported with the assembly diagnostics. */
  readonly diagnostics?: readonly BuildDiagnostic[];
}

export class AgentBuildError extends HarnessError {
  constructor(readonly diagnostics: readonly BuildDiagnostic[]) {
    super(
      "agent.build-failed",
      diagnostics.map((item) => item.message).join("; ") || "Agent build failed"
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

export function Agent<
  Info = unknown,
  Schema extends ToolSchemaSource | undefined = undefined
>(options: AgentOptions<Schema>): AgentBuilder<Info, Schema> {
  return AgentBuilder.create(options);
}

export namespace Agent {
  export function from<Info = unknown>(
    json: AgentManifest | import("../types/shared.js").JsonObject,
    implementations: Implementations<Info>
  ): BuiltAgent<Info> {
    return agentFrom(json, implementations);
  }
}

const SNAPSHOT = Symbol("AgentBuilder.snapshot");

export class AgentBuilder<
  Info = unknown,
  Schema extends ToolSchemaSource | undefined = undefined
> {
  readonly #snapshot: BuilderSnapshot;
  #agent?: BuiltAgent<
    Info,
    Schema extends ToolSchemaSource ? SchemaOutput<Schema> : string
  >;
  #error?: AgentBuildError;

  getBinding() {
    return this.build().getBinding();
  }

  constructor(options: AgentOptions<Schema>);
  /** @internal */
  constructor(snapshot: BuilderSnapshot, brand: typeof SNAPSHOT);
  constructor(
    optionsOrSnapshot: AgentOptions<Schema> | BuilderSnapshot,
    brand?: typeof SNAPSHOT
  ) {
    this.#snapshot =
      brand === SNAPSHOT
        ? (optionsOrSnapshot as BuilderSnapshot)
        : createSnapshot(optionsOrSnapshot as AgentOptions<Schema>);
  }

  static create<Info, Schema extends ToolSchemaSource | undefined>(
    options: AgentOptions<Schema>
  ): AgentBuilder<Info, Schema> {
    return new AgentBuilder(options);
  }

  private static withSnapshot<
    Info,
    Schema extends ToolSchemaSource | undefined
  >(snapshot: BuilderSnapshot): AgentBuilder<Info, Schema> {
    return new AgentBuilder(snapshot, SNAPSHOT);
  }

  /** Compose-time identity — available before `.build()`. */
  get id(): string {
    return this.#snapshot.id;
  }

  get name(): string | undefined {
    return this.#snapshot.name;
  }

  get manifest(): AgentManifest {
    return this.ensure().manifest;
  }

  toJSON(): AgentManifest {
    return this.ensure().toJSON();
  }

  use(middleware: StepMiddleware<Info>): AgentBuilder<Info, Schema>;
  use(id: string, middleware: StepMiddleware<Info>): AgentBuilder<Info, Schema>;
  use(declaration: CapabilityInput<Info>): AgentBuilder<Info, Schema>;
  use(
    idOrMiddleware: string | StepMiddleware<Info> | CapabilityInput<Info>,
    middleware?: StepMiddleware<Info>
  ): AgentBuilder<Info, Schema> {
    let compiled: ReturnType<typeof compileDeclaration>;
    if (typeof idOrMiddleware === "function") {
      compiled = {
        bound: {
          id: nextMiddlewareId(this.#snapshot.entries),
          handle: idOrMiddleware as StepMiddleware,
          hasMiddleware: true,
        },
        middleware: idOrMiddleware as StepMiddleware,
      };
    } else if (typeof idOrMiddleware === "object") {
      compiled = compileDeclaration(idOrMiddleware);
    } else {
      compiled = {
        bound: {
          id: idOrMiddleware,
          handle: middleware! as StepMiddleware,
          hasMiddleware: true,
        },
        middleware: middleware as StepMiddleware,
      };
    }
    const dynamics = new Map(this.#snapshot.dynamics);
    dynamics.set(compiled.bound.id, {
      ...(compiled.before ? { before: compiled.before } : {}),
      ...(compiled.after ? { after: compiled.after } : {}),
      ...(compiled.middleware ? { middleware: compiled.middleware } : {}),
    });
    return AgentBuilder.withSnapshot({
      ...this.#snapshot,
      entries: Object.freeze([...this.#snapshot.entries, compiled.bound]),
      dynamics,
    });
  }

  /**
   * Run `fn` before each turn (`"turn"`) or before every model call (`"step"`).
   * The returned Patch applies to the whole turn or to that one model call.
   */
  before<S extends HookScope>(
    scope: S,
    fn: BeforeHook<S, Info>
  ): AgentBuilder<Info, Schema> {
    return this.addAgentHook("before", scope, fn);
  }

  /**
   * Run `fn` after every model call (`"step"`) or after the turn's final answer (`"turn"`).
   */
  after<S extends HookScope>(
    scope: S,
    fn: AfterHook<S, Info>
  ): AgentBuilder<Info, Schema> {
    return this.addAgentHook("after", scope, fn);
  }

  private addAgentHook(
    at: HookAt,
    scope: HookScope,
    fn: unknown
  ): AgentBuilder<Info, Schema> {
    if (typeof fn !== "function")
      throw new HarnessError(
        "configuration.invalid",
        `${at}("${scope}") requires a function`
      );
    if (scope !== "turn" && scope !== "step")
      throw new HarnessError(
        "configuration.invalid",
        `Unknown hook scope '${String(scope)}'; use "turn" or "step"`
      );
    const dynamics = new Map(this.#snapshot.dynamics);
    const existing = dynamics.get("agent") ?? {};
    const current = existing[at] as Record<string, unknown> | undefined;
    if (current?.[scope] !== undefined)
      return AgentBuilder.withSnapshot({
        ...this.#snapshot,
        diagnostics: Object.freeze([
          ...(this.#snapshot.diagnostics ?? []),
          Object.freeze({
            code: "hook.duplicate",
            message: `Agent hook ${at}("${scope}") is registered more than once`,
          }),
        ]),
      });
    const next: CapabilityDynamics = {
      ...existing,
      [at]: Object.freeze({ ...current, [scope]: fn }),
    };
    dynamics.set("agent", next);
    return AgentBuilder.withSnapshot({
      ...this.#snapshot,
      entries: withAgentHooks(this.#snapshot.entries, next),
      dynamics,
    });
  }

  /** Optional no-op: returns the assembled agent facade. */
  build(): BuiltAgent<
    Info,
    Schema extends ToolSchemaSource ? SchemaOutput<Schema> : string
  > {
    return this.ensure();
  }

  private ensure(): BuiltAgent<
    Info,
    Schema extends ToolSchemaSource ? SchemaOutput<Schema> : string
  > {
    if (this.#agent) return this.#agent;
    if (this.#error) throw this.#error;
    if (this.#snapshot.diagnostics?.length) {
      this.#error = new AgentBuildError(this.#snapshot.diagnostics);
      throw this.#error;
    }
    const result = assembleAgent(
      this.#snapshot.entries,
      {
        id: this.#snapshot.id,
        name: this.#snapshot.name,
        description: this.#snapshot.description,
        metadata: this.#snapshot.metadata,
        outputSchema: this.#snapshot.outputSchema,
      },
      this.#snapshot.dynamics
    );
    if (!result.ok) {
      this.#error = new AgentBuildError(result.diagnostics);
      throw this.#error;
    }
    this.#agent = result.agent as BuiltAgent<
      Info,
      Schema extends ToolSchemaSource ? SchemaOutput<Schema> : string
    >;
    return this.#agent;
  }
}

function createSnapshot(
  options: AgentOptions<ToolSchemaSource | undefined>
): BuilderSnapshot {
  const entries: BoundMiddleware[] = [];
  const dynamics = new Map<string, CapabilityDynamics>();
  const instructions =
    options.instructions === undefined
      ? undefined
      : typeof options.instructions === "string"
      ? [options.instructions]
      : options.instructions;
  if (instructions !== undefined || options.tools !== undefined) {
    const compiled = compileDeclaration({
      id: "agent",
      ...(instructions === undefined ? {} : { instructions }),
      ...(options.tools === undefined ? {} : { tools: options.tools }),
    });
    entries.push(compiled.bound);
    dynamics.set("agent", {});
  }
  return {
    id: options.id,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.description === undefined
      ? {}
      : { description: options.description }),
    ...(options.metadata === undefined ? {} : { metadata: options.metadata }),
    outputSchema: options.outputSchema,
    entries: Object.freeze(entries),
    dynamics,
  };
}

function nextMiddlewareId(entries: readonly BoundMiddleware[]): string {
  const taken = new Set(entries.map((item) => item.id));
  let seq = 0;
  let id: string;
  do {
    seq += 1;
    id = `middleware-${seq}`;
  } while (taken.has(id));
  return id;
}

/** Record the agent-level hooks on the synthetic `"agent"` capability, creating it if needed. */
function withAgentHooks(
  entries: readonly BoundMiddleware[],
  dynamics: CapabilityDynamics
): readonly BoundMiddleware[] {
  const hooks = hooksFrom(dynamics.before, dynamics.after);
  const index = entries.findIndex((item) => item.id === "agent");
  if (index >= 0) {
    const next = Object.freeze({ ...entries[index]!, hooks });
    return Object.freeze([
      ...entries.slice(0, index),
      next,
      ...entries.slice(index + 1),
    ]);
  }
  return Object.freeze([
    ...entries,
    Object.freeze({
      id: "agent",
      handle: async (_request: unknown, next: () => Promise<unknown>) => next(),
      hasMiddleware: false,
      contributions: Object.freeze({}),
      hooks,
    } as BoundMiddleware),
  ]);
}

export type { Implementations };
