import { z } from "zod";
import {
  Agent,
  AgentBuildError,
  model as typedModel,
  tool as typedTool,
  type AgentOptions,
  type AgentBuilder,
  type BuiltAgent,
  type InputOptions,
  type JsonObject,
  type ModelCandidate,
  type ModelAdapter,
  type SessionOptions,
  type SessionInput,
  type Observer,
  type StepRequest,
  type StepResponse,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolOutcome,
} from "../src/index.js";

/**
 * Test-only bridge for suites written before model invocation became a
 * per-session concern. Production builders deliberately do not expose this
 * method; the bridge injects the fixture adapter at run time.
 */
type FixtureAgent = BuiltAgent & {
  run(options?: Omit<SessionOptions, "onModelCall">): FixtureSession;
};

type FixtureSession = ReturnType<BuiltAgent["run"]> & {
  observe(listener: Observer): () => void;
};

type FixtureBuilder = AgentBuilder & {
  with(adapter: ModelAdapter): FixtureBuilder;
  build(): FixtureAgent;
};

export const objectSchema = z.object({}).passthrough();

export function testAgent(options: Partial<AgentOptions> = {}) {
  const builder = Agent({
    id: options.id ?? "test",
    name: options.name ?? "Test",
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  }) as FixtureBuilder;
  const build = builder.build.bind(builder);
  let adapter: ModelAdapter | undefined;
  let fixtureAgent: FixtureAgent | undefined;
  builder.with = (value) => {
    adapter = value;
    return builder;
  };
  builder.build = () => {
    if (fixtureAgent) return fixtureAgent;
    const agent = build();
    fixtureAgent = Object.create(agent) as FixtureAgent;
    fixtureAgent.run = (options = {}) => {
      if (!adapter) throw new Error("Test agent requires a model adapter via with().");
      const observers = new Set<Observer>();
      const bootstrapEvents: Parameters<Observer>[0][] = [];
      let subscribed = false;
      const session = agent.run({
        ...options,
        onModelCall: adapter,
        observer: (event) => {
          options.observer?.(event);
          if (!subscribed) bootstrapEvents.push(event);
          for (const observer of [...observers]) {
            try {
              const result = observer(event);
              if (result && typeof (result as PromiseLike<void>).then === "function")
                void Promise.resolve(result).catch(() => undefined);
            } catch {
              // Fixture observers retain the public API's fail-open contract.
            }
          }
        },
      });
      const fixtureSession = Object.create(session) as FixtureSession;
      fixtureSession.observe = (observer) => {
        if (!subscribed) {
          subscribed = true;
          for (const event of bootstrapEvents) observer(event);
          bootstrapEvents.length = 0;
        }
        observers.add(observer);
        return () => observers.delete(observer);
      };
      return fixtureSession;
    };
    return fixtureAgent;
  };
  return builder;
}

export function tool(
  name = "echo",
  execute: ToolDefinition["execute"] = async (args) => ({ kind: "completed", output: args }),
) {
  return typedTool({ name, inputSchema: objectSchema, execute });
}

export function offer(...tools: ReturnType<typeof tool>[]) {
  return async (request: StepRequest, next: () => Promise<StepResponse>) => {
    request.configuration.tools.set("fixture-tools", tools);
    return next();
  };
}

export function execution(
  execute?: (
    call: { readonly args: JsonObject; readonly callId?: string; readonly toolName?: string },
    context: ToolExecutionContext,
  ) => Promise<ToolOutcome>,
): ToolDefinition["execute"] {
  return async (args, context) =>
    execute
      ? execute({ args: args as JsonObject }, context)
      : { kind: "completed" as const, output: args as JsonObject };
}

export function model(invoke: ModelAdapter) {
  return typedModel(invoke);
}

export function toolCalls(
  ...calls: readonly { readonly id: string; readonly name: string; readonly args?: JsonObject }[]
): ModelCandidate {
  return {
    output: calls.map((call) => ({
      type: "tool-call" as const,
      id: call.id,
      name: call.name,
      args: call.args ?? {},
    })),
  };
}

export function expectBuildError(build: () => unknown): AgentBuildError {
  try {
    build();
  } catch (error) {
    if (error instanceof AgentBuildError) return error;
    throw error;
  }
  throw new Error("expected AgentBuildError");
}

export function turn(
  agent: BuiltAgent,
  input: SessionInput = "go",
  options: SessionOptions & InputOptions = {},
) {
  const session = agent.run({
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  const handle = session.input(
    input,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return { session, handle };
}
