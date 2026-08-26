import type { InputEvent } from "../types/session.js";
import type { ModelRequest } from "../types/model.js";
import type { ToolResult } from "../types/tool.js";
import type { StepContext } from "./context.js";

export function resolveModelRequest(input: {
  context: StepContext;
  arrivals: readonly InputEvent[];
  toolResults: readonly ToolResult[];
  sessionContext?: import("../types/shared.js").JsonObject;
}): ModelRequest {
  const ctx = input.context;
  return Object.freeze({
    sessionId: ctx.input.sessionId,
    turnId: ctx.input.turnId,
    stepId: ctx.input.stepId,
    ...(ctx.selectedDirective === undefined ? {} : { model: ctx.selectedDirective }),
    prefix: ctx.prefixSnapshot(),
    instructions: Object.freeze([...ctx.instructions]),
    context: Object.freeze([
      ...(input.sessionContext ? [{ type: "session", value: input.sessionContext }] : []),
      ...ctx.contextItems,
    ]),
    transcript: Object.freeze([...ctx.input.transcript]),
    arrivals: Object.freeze([...input.arrivals]),
    toolResults: Object.freeze([...input.toolResults]),
    tools: Object.freeze([...ctx.offeredTools]),
  });
}
