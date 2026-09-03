import { z } from "zod";
import {
  Agent,
  AgentBuildError,
  model as typedModel,
  tool as typedTool,
  type AgentOptions,
  type BuiltAgent,
  type InputOptions,
  type JsonObject,
  type ModelCandidate,
  type ModelAdapter,
  type SessionOptions,
  type SessionInput,
  type StepRequest,
  type StepResponse,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolOutcome,
} from "../src/index.js";

export const objectSchema = z.object({}).passthrough();

export function testAgent(options: Partial<AgentOptions> = {}) {
  return Agent({
    id: options.id ?? "test",
    name: options.name ?? "Test",
    ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
  });
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
