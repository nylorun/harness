import { z } from "zod";
import {
  AgentBuildError,
  adapter as typedAdapter,
  model as typedModel,
  tool as typedTool,
  type BuiltAgent,
  type InputOptions,
  type JsonObject,
  type ModelCandidate,
  type ModelAdapter,
  type SessionOptions,
  type SessionInput,
  type StepRequest,
  type StepResponse,
  type ToolAdapter,
} from "../src/index.js";

export const objectSchema = z.object({}).passthrough();

export function tool(name = "echo", executeWith = "local") {
  return typedTool({ name, parameters: objectSchema, executeWith });
}

export function offer(...tools: ReturnType<typeof tool>[]) {
  return async (request: StepRequest, next: () => Promise<StepResponse>) => {
    request.configuration.tools.set("fixture-tools", tools);
    return next();
  };
}

export function adapter(execute?: ToolAdapter["execute"]) {
  return typedAdapter({
    id: "local",
    execute: execute ?? (async (call) => ({ kind: "completed" as const, output: call.args })),
  });
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
