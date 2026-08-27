import type { ZodObject } from "zod";
import type { ToolDefinition } from "./types.js";

const TOOL = Symbol.for("nylo.tool.definition");

export type InternalToolDefinition<Input extends ZodObject = ZodObject, Output = unknown> = ToolDefinition<Input, Output> & {
  readonly [TOOL]: true;
};

export function tool<Input extends ZodObject, Output>(definition: ToolDefinition<Input, Output>): ToolDefinition<Input, Output> {
  if (!definition.description.trim()) throw new TypeError("Tool description is required");
  if (definition.maxCallsPerSession !== undefined && (!Number.isInteger(definition.maxCallsPerSession) || definition.maxCallsPerSession < 1)) {
    throw new TypeError("maxCallsPerSession must be a positive integer");
  }
  return Object.freeze(Object.defineProperty({ ...definition }, TOOL, { value: true, enumerable: false }));
}

export function isToolDefinition(value: unknown): value is InternalToolDefinition {
  return typeof value === "object" && value !== null && (value as InternalToolDefinition)[TOOL] === true;
}
