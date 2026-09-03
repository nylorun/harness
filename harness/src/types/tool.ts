import type { ZodType } from "zod";
import type { DeferredOutcome, JsonObject, JsonValue } from "./shared.js";

export interface SchemaIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export type SchemaValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly SchemaIssue[] };

/** The portable, locally-enforced schema contract accepted by a Harness tool. */
export interface ToolSchema<T> {
  readonly jsonSchema: JsonObject;
  validate(value: unknown): SchemaValidation<T>;
}

/** The synchronous Standard Schema subset required to project and validate a tool contract. */
export interface StandardToolSchema<Input = unknown, Output = unknown> {
  readonly "~standard": {
    readonly validate: (
      value: Input,
    ) =>
      | { readonly value: Output; readonly issues?: undefined }
      | { readonly issues: readonly StandardSchemaIssue[]; readonly value?: undefined }
      | Promise<unknown>;
    readonly jsonSchema: {
      readonly input: () => unknown;
      readonly output: () => unknown;
    };
  };
}

export interface StandardSchemaIssue {
  readonly message?: string;
  readonly path?: readonly (string | number | symbol)[];
  readonly code?: string;
}

export type ToolSchemaSource<T = unknown> = ZodType<T> | StandardToolSchema<any, T> | ToolSchema<T>;

export type SchemaOutput<Schema> =
  Schema extends ZodType<infer Value>
    ? Value
    : Schema extends StandardToolSchema<any, infer Value>
      ? Value
      : Schema extends ToolSchema<infer Value>
        ? Value
        : never;

export type ToolInputSchema = ToolSchemaSource;
export type ToolOutputSchema = ToolSchemaSource;

export interface BoundToolSchema<T> extends ToolSchema<T> {}

type OutputFor<Schema> = Schema extends ToolSchemaSource ? SchemaOutput<Schema> : ToolContent;

export interface ToolDefinition<
  InputSchema extends ToolInputSchema = ToolInputSchema,
  State = never,
  OutputSchema extends ToolOutputSchema | undefined = undefined,
> {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: InputSchema;
  readonly outputSchema?: OutputSchema;
  execute(
    args: SchemaOutput<InputSchema>,
    context: ToolExecutionContext<State>,
  ): Promise<ToolOutcome<OutputFor<OutputSchema>>>;
}

export interface BoundToolDefinition<State = never> extends Omit<
  ToolDefinition<ToolInputSchema, State, ToolOutputSchema | undefined>,
  "inputSchema" | "outputSchema" | "execute"
> {
  readonly inputSchema: BoundToolSchema<unknown>;
  readonly outputSchema?: BoundToolSchema<unknown>;
  readonly execute: (args: unknown, context: ToolExecutionContext<State>) => Promise<ToolOutcome>;
  readonly owner: ToolOwner;
}

export interface ToolOwner {
  readonly middlewareId: string;
  readonly slot: string;
}

export interface Interaction {
  readonly id?: string;
  readonly kind: "approval" | "response";
  readonly prompt: string;
  readonly metadata?: JsonObject;
}

export interface RequiredInteraction extends Interaction {
  readonly id: string;
}

export interface ToolExecutionResume {
  readonly interactionId: string;
  readonly kind: "approval" | "response";
  readonly approved?: boolean;
  readonly value?: JsonValue;
  readonly token?: JsonValue;
}

export interface SealedToolCall {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
}

interface ToolExecutionContextBase {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly callId: string;
  readonly invocationId: string;
  readonly signal: AbortSignal;
  readonly resume?: ToolExecutionResume;
}

export type ToolExecutionContext<State = never> = ToolExecutionContextBase &
  ([State] extends [never] ? object : { readonly state: Promise<State> });

export type ToolContent = JsonValue;
export type ToolOutcome<Output = ToolContent> =
  | { readonly kind: "completed"; readonly output: Output }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  | {
      readonly kind: "interaction-required";
      readonly interaction: Interaction;
      readonly token?: JsonValue;
    }
  | DeferredOutcome;

export interface ToolValidationFailureDetails {
  readonly phase: "input" | "output";
  readonly issues: readonly SchemaIssue[];
}

export type ToolResult =
  | {
      readonly callId: string;
      readonly toolName: string;
      readonly kind: "completed";
      readonly output: ToolContent;
    }
  | {
      readonly callId: string;
      readonly toolName: string;
      readonly kind: "denied";
      readonly reason: string;
    }
  | {
      readonly callId: string;
      readonly toolName: string;
      readonly kind: "failed";
      readonly code: string;
      readonly message: string;
      readonly details?: ToolValidationFailureDetails;
    };
