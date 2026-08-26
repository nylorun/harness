import type { ZodObject, output } from "zod";
import type { JsonObject, JsonValue } from "./shared.js";

type SchemaValidationSuccess<T> = { readonly ok: true; readonly value: T };
type SchemaValidationFailure = { readonly ok: false; readonly issues: readonly string[] };
type SchemaValidation<T> = SchemaValidationSuccess<T> | SchemaValidationFailure;

/** Harness tool inputs are synchronous Zod object schemas. */
export type ToolObjectSchema = ZodObject;

interface BoundToolSchema<T> {
  readonly jsonSchema: JsonObject;
  validate(value: unknown): SchemaValidation<T>;
}

export interface ToolDefinition<
  Input extends ToolObjectSchema = ToolObjectSchema,
  Route extends JsonValue = JsonValue,
> {
  readonly name: string;
  readonly description?: string;
  readonly input: Input;
  readonly executeWith: string;
  readonly route: Route;
  readonly metadata?: JsonObject;
}

export interface BoundToolDefinition<
  Input extends ToolObjectSchema = ToolObjectSchema,
  Route extends JsonValue = JsonValue,
> extends Omit<ToolDefinition<Input, Route>, "input"> {
  readonly input: BoundToolSchema<output<Input>>;
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

export interface SealedToolCall<Route extends JsonValue = JsonValue> {
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
  readonly executeWith: string;
  readonly route: Route;
}

export type ToolContent = JsonValue;
export type ToolOutcome =
  | { readonly kind: "completed"; readonly output: ToolContent }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  | {
      readonly kind: "interaction-required";
      readonly interaction: Interaction;
      readonly token?: JsonValue;
    };

export type PreflightOutcome =
  { readonly kind: "completed" } | Exclude<ToolOutcome, { readonly kind: "completed" }>;

export interface ToolAdapter<Route extends JsonValue = JsonValue> {
  readonly id: string;
  validateRoute(route: Route): void;
  preflight?(
    call: SealedToolCall<Route>,
    context: {
      readonly kind: "sandbox" | "validation";
      readonly invocationId: string;
      readonly signal: AbortSignal;
      readonly resume?: ToolExecutionResume;
    },
  ): Promise<PreflightOutcome>;
  execute(
    call: SealedToolCall<Route>,
    context: {
      readonly invocationId: string;
      readonly signal: AbortSignal;
      readonly resume?: ToolExecutionResume;
    },
  ): Promise<ToolOutcome>;
}

export interface ToolResult {
  readonly callId: string;
  readonly toolName: string;
  readonly kind: "completed" | "denied" | "failed";
  readonly output?: ToolContent;
  readonly reason?: string;
  readonly code?: string;
  readonly message?: string;
}
