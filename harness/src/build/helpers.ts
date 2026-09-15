import type { ModelAdapter } from "../types/model.js";
import type { StepMiddleware } from "../types/middleware.js";
import type { ToolDefinition, ToolInputSchema, ToolOutputSchema } from "../types/tool.js";
import { prepareTool } from "./schema.js";

export const tool = <
  InputSchema extends ToolInputSchema,
  Scope = unknown,
  OutputSchema extends ToolOutputSchema | undefined = undefined,
>(
  value: ToolDefinition<InputSchema, Scope, OutputSchema>,
): ToolDefinition<InputSchema, Scope, OutputSchema> =>
  prepareTool(value as ToolDefinition) as ToolDefinition<InputSchema, Scope, OutputSchema>;
export const model = <T extends ModelAdapter>(value: T): T => value;
export const middleware = <T extends StepMiddleware>(value: T): T => value;
