import type { Capability } from "./types/capability.js";
import type { ModelInvoker } from "./types/model.js";
import type { StepMiddleware } from "./types/middleware.js";
import type { ToolAdapter, ToolDefinition } from "./types/tool.js";

export const defineCapability = <T extends Capability>(value: T): T => value;
export const defineTool = <T extends ToolDefinition>(value: T): T => value;
export const defineMiddleware = <T extends StepMiddleware>(value: T): T => value;
export const defineAdapter = <T extends ToolAdapter>(value: T): T => value;
export const defineModel = <T extends ModelInvoker>(value: T): T => value;
