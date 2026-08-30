import type { ModelAdapter } from "../types/model.js";
import type { StepMiddleware } from "../types/middleware.js";
import type { ToolDefinition, ToolObjectSchema } from "../types/tool.js";
import { prepareTool } from "./schema.js";

export const tool = <Parameters extends ToolObjectSchema, State = never>(
  value: ToolDefinition<Parameters, State>,
): ToolDefinition<Parameters, State> =>
  prepareTool(value as ToolDefinition<Parameters>) as ToolDefinition<Parameters, State>;
export const model = <T extends ModelAdapter>(value: T): T => value;
export const middleware = <T extends StepMiddleware>(value: T): T => value;
