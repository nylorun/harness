import { z } from "zod";
import {
  defineAdapter,
  defineCapability,
  defineModel,
  defineTool,
  type Agent,
  type AgentRunInput,
  type InputOptions,
  type ModelInvoker,
  type SessionOptions,
  type ToolAdapter,
} from "../src/index.js";

export const objectSchema = z.object({}).passthrough();

export function tool(name = "echo", executeWith = "local") {
  return defineTool({ name, input: objectSchema, executeWith, route: { operation: name } });
}

export function capability(...tools: ReturnType<typeof tool>[]) {
  return defineCapability({ id: "test", setup: () => ({ tools }) });
}

export function adapter(execute?: ToolAdapter["execute"]) {
  return defineAdapter({
    id: "local",
    validateRoute() {},
    execute: execute ?? (async (call) => ({ kind: "completed" as const, output: call.args })),
  });
}

export function model(invoke: ModelInvoker["invoke"]) {
  return defineModel({ id: "test-model", invoke });
}

export function turn(
  agent: Agent,
  input: AgentRunInput = "go",
  options: SessionOptions & InputOptions = {},
) {
  const session = agent.run({
    ...(options.id === undefined ? {} : { id: options.id }),
    ...(options.userId === undefined ? {} : { userId: options.userId }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  const handle = session.input(
    input,
    options.signal === undefined ? {} : { signal: options.signal },
  );
  return { session, handle };
}
