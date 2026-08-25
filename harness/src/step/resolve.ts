import type { InputEvent, TranscriptEntry } from "../types/session.js";
import type { ModelRequest } from "../types/model.js";
import type { BoundToolDefinition, ToolResult } from "../types/tool.js";
import type { StepContext } from "./context.js";

export function resolveModelRequest(input: {
  context: StepContext;
  defaultModel: string;
  boundInstructions: readonly string[];
  transcript: readonly TranscriptEntry[];
  arrivals: readonly InputEvent[];
  toolResults: readonly ToolResult[];
  tools: readonly BoundToolDefinition[];
  sessionContext?: import("../types/shared.js").JsonObject;
}): ModelRequest {
  const ctx = input.context;
  return Object.freeze({
    sessionId: ctx.input.sessionId,
    turnId: ctx.input.turnId,
    stepId: ctx.input.stepId,
    modelId: ctx.selectedModel ?? input.defaultModel,
    instructions: Object.freeze([...input.boundInstructions, ...ctx.instructions]),
    context: Object.freeze([
      ...(input.sessionContext ? [{ type: "session", value: input.sessionContext }] : []),
      ...ctx.contextItems,
    ]),
    transcript: Object.freeze([...input.transcript]),
    arrivals: Object.freeze([...input.arrivals]),
    toolResults: Object.freeze([...input.toolResults]),
    tools: Object.freeze(input.tools.filter((tool) => !ctx.isToolHidden(tool.name))),
  });
}
