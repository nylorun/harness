import type { MiddlewareContributions, StepMiddleware } from "../types/middleware.js";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolInputSchema,
  ToolOutcome,
  ToolOutputSchema,
  ToolOwner,
  ToolSchema,
} from "../types/tool.js";

export interface BoundToolDefinition<Info = unknown> extends Omit<
  ToolDefinition<ToolInputSchema, Info, ToolOutputSchema | undefined>,
  "inputSchema" | "outputSchema" | "execute"
> {
  readonly inputSchema: ToolSchema<unknown>;
  readonly outputSchema?: ToolSchema<unknown>;
  readonly execute: (args: unknown, context: ToolExecutionContext<Info>) => Promise<ToolOutcome>;
  readonly owner: ToolOwner;
  readonly source: ToolDefinition<any, any, any>;
}

export interface BoundMiddleware {
  readonly id: string;
  readonly handle: StepMiddleware;
  readonly hasMiddleware: boolean;
  readonly tools?: readonly ToolDefinition<any, any, any>[];
  readonly contributions?: MiddlewareContributions;
}
