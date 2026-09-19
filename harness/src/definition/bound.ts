import type { MiddlewareContributions, StepMiddleware } from "../types/middleware.js";
import type {
  ToolApproval,
  ToolDefinition,
  ToolEffects,
  ToolExecutionContext,
  ToolInputSchema,
  ToolOutcome,
  ToolOutputSchema,
  ToolOwner,
  ToolRunResult,
  ToolSchema,
} from "../types/tool.js";

export interface BoundToolDefinition<Info = unknown> extends Omit<
  ToolDefinition<ToolInputSchema, Info, ToolOutputSchema | undefined>,
  "inputSchema" | "outputSchema" | "execute" | "run" | "input" | "output"
> {
  readonly inputSchema: ToolSchema<unknown>;
  readonly outputSchema?: ToolSchema<unknown>;
  readonly execute: (args: unknown, context: ToolExecutionContext<Info>) => Promise<ToolRunResult>;
  readonly approval?: ToolApproval<ToolInputSchema>;
  readonly effects?: ToolEffects;
  readonly owner: ToolOwner;
  readonly source: ToolDefinition<any, any, any>;
}

export interface BoundMiddleware {
  readonly id: string;
  readonly handle: StepMiddleware;
  readonly hasMiddleware: boolean;
  readonly tools?: readonly ToolDefinition<any, any, any>[];
  readonly contributions?: MiddlewareContributions;
  readonly beforeModelCall?: boolean;
  readonly afterModelCall?: boolean;
}
