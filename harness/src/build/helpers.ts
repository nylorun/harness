import type { ModelAdapter } from "../types/model.js";
import type { StepMiddleware } from "../types/middleware.js";
import type { ToolAdapter, ToolDefinition } from "../types/tool.js";
import { prepareTool } from "./schema.js";

export const tool = <T extends ToolDefinition>(value: T): T => prepareTool(value);
export const adapter = <T extends ToolAdapter>(value: T): T => value;
export const model = <T extends ModelAdapter>(value: T): T => value;
export const middleware = <T extends StepMiddleware>(value: T): T => value;
