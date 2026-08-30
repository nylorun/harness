import type { ZodObject, output } from "zod";
import type { DeferredOutcome, JsonObject, JsonValue } from "./shared.js";

type SchemaValidationSuccess<T> = { readonly ok: true; readonly value: T };
type SchemaValidationFailure = { readonly ok: false; readonly issues: readonly string[] };
type SchemaValidation<T> = SchemaValidationSuccess<T> | SchemaValidationFailure;

/** Harness tool parameters are synchronous Zod object schemas. */
export type ToolObjectSchema = ZodObject;

export interface BoundToolSchema<T> {
  readonly jsonSchema: JsonObject;
  validate(value: unknown): SchemaValidation<T>;
}

export interface ToolDefinition<
  Parameters extends ToolObjectSchema = ToolObjectSchema,
  State = never,
> {
  readonly name: string;
  readonly description?: string;
  readonly parameters: Parameters;
  execute(args: output<Parameters>, context: ToolExecutionContext<State>): Promise<ToolOutcome>;
}

export interface BoundToolDefinition<
  Parameters extends ToolObjectSchema = ToolObjectSchema,
  State = never,
> extends Omit<ToolDefinition<Parameters, State>, "parameters" | "execute"> {
  readonly parameters: BoundToolSchema<output<Parameters>>;
  readonly execute: ToolDefinition<Parameters, State>["execute"];
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
export type ToolOutcome =
  | { readonly kind: "completed"; readonly output: ToolContent }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "failed"; readonly code: string; readonly message: string }
  | {
      readonly kind: "interaction-required";
      readonly interaction: Interaction;
      readonly token?: JsonValue;
    }
  | DeferredOutcome;

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
    };
