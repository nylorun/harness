import type { ZodObject, output } from "zod";
import type { JsonObject, JsonValue } from "./shared.js";

type SchemaValidationSuccess<T> = { readonly ok: true; readonly value: T };
type SchemaValidationFailure = { readonly ok: false; readonly issues: readonly string[] };
type SchemaValidation<T> = SchemaValidationSuccess<T> | SchemaValidationFailure;

/** Harness tool parameters are synchronous Zod object schemas. */
export type ToolObjectSchema = ZodObject;

export interface BoundToolSchema<T> {
  readonly jsonSchema: JsonObject;
  validate(value: unknown): SchemaValidation<T>;
}

export interface ToolDefinition<Parameters extends ToolObjectSchema = ToolObjectSchema> {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Parameters;
  readonly executeWith: string;
}

export interface BoundToolDefinition<
  Parameters extends ToolObjectSchema = ToolObjectSchema,
> extends Omit<ToolDefinition<Parameters>, "parameters"> {
  readonly parameters: BoundToolSchema<output<Parameters>>;
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
  readonly executeWith: string;
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

export interface ToolAdapter {
  readonly id: string;
  preflight?(
    call: SealedToolCall,
    context: {
      readonly kind: "sandbox" | "validation";
      readonly invocationId: string;
      readonly signal: AbortSignal;
      readonly resume?: ToolExecutionResume;
    },
  ): Promise<PreflightOutcome>;
  execute(
    call: SealedToolCall,
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
