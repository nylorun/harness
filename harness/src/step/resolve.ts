import type { InputEvent } from "../types/transcript.js";
import type { ModelRequest } from "../types/model.js";
import type { ToolResult } from "../types/tool.js";
import type { StepContext } from "./step-context.js";

export function resolveModelRequest(input: {
  context: StepContext;
  arrivals: readonly InputEvent[];
  toolResults: readonly ToolResult[];
  output?: import("../execution/output-contract.js").TurnOutputContract;
}): ModelRequest {
  const ctx = input.context;
  return Object.freeze({
    executionId: ctx.input.executionId,
    turnId: ctx.input.turnId,
    stepId: ctx.input.stepId,
    ...(ctx.selectedDirective === undefined ? {} : { model: ctx.selectedDirective }),
    configuration: ctx.configurationSnapshot(),
    instructions: Object.freeze([...ctx.instructions]),
    context: ctx.contextSnapshot(),
    transcript: Object.freeze([...ctx.input.transcript]),
    arrivals: Object.freeze([...input.arrivals]),
    toolResults: Object.freeze([...input.toolResults]),
    tools: Object.freeze([...ctx.offeredTools]),
    ...(input.output === undefined ? {} : { outputSchema: input.output.schema.jsonSchema }),
  });
}
