import type { ModelAdapter } from "../types/model.js";
import type { StepMiddleware } from "../types/middleware.js";
import type {
  ToolDefinition,
  ToolInputSchema,
  ToolOutputSchema,
  ToolSchemaSource,
} from "../types/tool.js";
import { prepareTool } from "./schema.js";

export const tool = <
  InputSchema extends ToolInputSchema,
  Info = unknown,
  OutputSchema extends ToolOutputSchema | undefined = undefined
>(
  value: ToolDefinition<InputSchema, Info, OutputSchema>
): ToolDefinition<InputSchema, Info, OutputSchema> =>
  prepareTool(value as ToolDefinition) as ToolDefinition<
    InputSchema,
    Info,
    OutputSchema
  >;

/** @deprecated Prefer Runtime model resolution. Capability-disguised `.use({ model })` is not the taught path. */
export const model = <T extends ModelAdapter>(value: T): T => value;

/** @deprecated Prefer `beforeModelCall` / `afterModelCall`. Kept through 1.0. */
export const middleware = <T extends StepMiddleware>(value: T): T => value;

/** Compose a reusable capability bundle (tools, instructions, optional dynamics). */
export function capability<Info = unknown>(declaration: {
  readonly id: string;
  readonly tools?: readonly ToolDefinition<any, Info, any>[];
  readonly instructions?: string | readonly string[];
  readonly beforeModelCall?: import("../types/dynamics.js").BeforeModelCallFn<Info>;
  readonly afterModelCall?: import("../types/dynamics.js").AfterModelCallFn<Info>;
  /** @deprecated Prefer beforeModelCall / afterModelCall. */
  readonly middleware?: StepMiddleware<Info>;
  /** @deprecated Model resolution is Runtime-owned; not projected into the manifest. */
  readonly model?: import("../types/model.js").ModelDirective;
}): import("../types/middleware.js").CapabilityDeclaration<Info> {
  const instructions =
    declaration.instructions === undefined
      ? undefined
      : typeof declaration.instructions === "string"
      ? [declaration.instructions]
      : declaration.instructions;
  return {
    id: declaration.id,
    ...(declaration.tools === undefined ? {} : { tools: declaration.tools }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(declaration.beforeModelCall === undefined
      ? {}
      : { beforeModelCall: declaration.beforeModelCall }),
    ...(declaration.afterModelCall === undefined
      ? {}
      : { afterModelCall: declaration.afterModelCall }),
    ...(declaration.middleware === undefined
      ? {}
      : { middleware: declaration.middleware }),
    ...(declaration.model === undefined ? {} : { model: declaration.model }),
  };
}

export type { ToolSchemaSource };
