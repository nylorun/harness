import { z } from "zod";
import { HarnessError } from "../errors.js";
import type {
  BoundToolSchema,
  SchemaIssue,
  SchemaValidation,
  StandardSchemaIssue,
  StandardToolSchema,
  ToolDefinition,
  ToolSchema,
  ToolSchemaSource,
} from "../types/tool.js";
import { copyJsonObject } from "../utils/immutable.js";

export type { SchemaValidation } from "../types/tool.js";

interface NormalizedToolSchemas {
  readonly inputSchema: BoundToolSchema<unknown>;
  readonly outputSchema?: BoundToolSchema<unknown>;
}

const preparedSchemas = new WeakMap<object, NormalizedToolSchemas>();

/** Creates a portable, explicitly validated schema source from raw JSON Schema. */
export function defineSchema<T>(value: ToolSchema<T>): ToolSchema<T> {
  if (!value || typeof value !== "object" || typeof value.validate !== "function")
    throw new HarnessError("tool.invalid-schema", "Tool schema must provide validate()");
  return Object.freeze({
    jsonSchema: copyJsonObject(value.jsonSchema, "tool schema jsonSchema"),
    validate: value.validate.bind(value),
  });
}

/** Eagerly prepares a definition authored through Harness's tool() helper. */
export function prepareTool<T extends ToolDefinition>(definition: T): T {
  normalizedSchemasFor(definition);
  return definition;
}

/** Returns cached normalized contracts, preparing raw definitions on first bind. */
export function normalizedSchemasFor(definition: ToolDefinition): NormalizedToolSchemas {
  const cached = preparedSchemas.get(definition);
  if (cached) return cached;
  const normalized = Object.freeze({
    inputSchema: normalizeSchema(definition.inputSchema, "input"),
    ...(definition.outputSchema === undefined
      ? {}
      : { outputSchema: normalizeSchema(definition.outputSchema, "output") }),
  });
  preparedSchemas.set(definition, normalized);
  return normalized;
}

/** Converts an accepted tool schema source into Harness's immutable runtime representation. */
export function normalizeSchema<T>(
  source: ToolSchemaSource<T>,
  role: "input" | "output",
): BoundToolSchema<T> {
  const normalized = isZodSchema(source)
    ? normalizeZodSchema(source, role)
    : isStandardSchema(source)
      ? normalizeStandardSchema(source, role)
      : isToolSchema(source)
        ? normalizeExplicitSchema(source)
        : undefined;
  if (!normalized)
    throw new HarnessError(
      "tool.invalid-schema",
      "Tool schema must be a Zod schema, synchronous Standard Schema with JSON Schema conversion, or defineSchema() contract",
    );
  if (role === "input" && normalized.jsonSchema.type !== "object")
    throw new HarnessError(
      "tool.invalid-schema",
      "Tool inputSchema JSON Schema root type must be object",
    );
  return normalized as BoundToolSchema<T>;
}

function normalizeZodSchema(source: z.ZodType, role: "input" | "output"): BoundToolSchema<unknown> {
  if (hasDeclaredAsyncWork(source))
    throw new HarnessError("tool.invalid-schema", "Tool schema must validate synchronously");
  let jsonSchema: import("../types/shared.js").JsonObject;
  try {
    jsonSchema = copyJsonObject(
      z.toJSONSchema(source, { target: "draft-07" }),
      `tool.${role}Schema.jsonSchema`,
    );
  } catch (error) {
    throw new HarnessError(
      "tool.invalid-schema",
      `Tool ${role}Schema must convert to JSON Schema: ${message(error)}`,
      { cause: error },
    );
  }
  return Object.freeze({
    jsonSchema,
    validate(value: unknown): SchemaValidation<unknown> {
      try {
        const result = source.safeParse(value);
        if (result.success) return { ok: true, value: result.data };
        return {
          ok: false,
          issues: Object.freeze(
            result.error.issues.map((entry) =>
              issue(entry.path.filter(isPathSegment), entry.code, entry.message),
            ),
          ),
        };
      } catch (error) {
        return { ok: false, issues: [issue([], "schema_error", synchronousIssue(error))] };
      }
    },
  });
}

function normalizeStandardSchema(
  source: StandardToolSchema,
  role: "input" | "output",
): BoundToolSchema<unknown> {
  let jsonSchema: import("../types/shared.js").JsonObject;
  try {
    jsonSchema = copyJsonObject(
      role === "input"
        ? source["~standard"].jsonSchema.input()
        : source["~standard"].jsonSchema.output(),
      `tool.${role}Schema.jsonSchema`,
    );
  } catch (error) {
    throw new HarnessError(
      "tool.invalid-schema",
      `Tool ${role}Schema must convert to JSON Schema: ${message(error)}`,
      { cause: error },
    );
  }
  return Object.freeze({
    jsonSchema,
    validate(value: unknown): SchemaValidation<unknown> {
      try {
        const result = source["~standard"].validate(value);
        if (isPromiseLike(result))
          return {
            ok: false,
            issues: [issue([], "async_validation", "Schema validation must be synchronous")],
          };
        if (result && typeof result === "object" && "issues" in result && result.issues)
          return { ok: false, issues: Object.freeze(result.issues.map(standardIssue)) };
        if (result && typeof result === "object" && "value" in result)
          return { ok: true, value: result.value };
        return {
          ok: false,
          issues: [issue([], "schema_error", "Standard Schema returned an invalid result")],
        };
      } catch (error) {
        return { ok: false, issues: [issue([], "schema_error", synchronousIssue(error))] };
      }
    },
  });
}

function normalizeExplicitSchema(source: ToolSchema<unknown>): BoundToolSchema<unknown> {
  return Object.freeze({
    jsonSchema: copyJsonObject(source.jsonSchema, "tool schema jsonSchema"),
    validate(value: unknown): SchemaValidation<unknown> {
      try {
        const result = source.validate(value);
        if (isPromiseLike(result))
          return {
            ok: false,
            issues: [issue([], "async_validation", "Schema validation must be synchronous")],
          };
        if (!result || typeof result !== "object" || typeof result.ok !== "boolean")
          return {
            ok: false,
            issues: [issue([], "schema_error", "Tool schema returned an invalid result")],
          };
        if (result.ok) return { ok: true, value: result.value };
        return { ok: false, issues: Object.freeze(result.issues.map(normalizeIssue)) };
      } catch (error) {
        return { ok: false, issues: [issue([], "schema_error", synchronousIssue(error))] };
      }
    },
  });
}

function isZodSchema(value: unknown): value is z.ZodType {
  return value instanceof z.ZodType;
}

function isStandardSchema(value: unknown): value is StandardToolSchema {
  if (!value || typeof value !== "object" || !("~standard" in value)) return false;
  const standard = (value as { "~standard"?: unknown })["~standard"];
  if (!standard || typeof standard !== "object") return false;
  const record = standard as { validate?: unknown; jsonSchema?: unknown };
  if (
    typeof record.validate !== "function" ||
    !record.jsonSchema ||
    typeof record.jsonSchema !== "object"
  )
    return false;
  const jsonSchema = record.jsonSchema as { input?: unknown; output?: unknown };
  return typeof jsonSchema.input === "function" && typeof jsonSchema.output === "function";
}

function isToolSchema(value: unknown): value is ToolSchema<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    "jsonSchema" in value &&
    "validate" in value &&
    typeof (value as { validate?: unknown }).validate === "function"
  );
}

/** Zod exposes declared checks in its stable v4 definition graph; reject async checks before a run. */
function hasDeclaredAsyncWork(schema: z.ZodType): boolean {
  return visitDefinition((schema as unknown as { _zod?: { def?: unknown } })._zod?.def, new Set());
}

function visitDefinition(value: unknown, seen: Set<object>): boolean {
  if (typeof value === "function") return value.constructor.name === "AsyncFunction";
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const nestedDefinition = (value as { _zod?: { def?: unknown } })._zod?.def;
  if (nestedDefinition !== undefined && nestedDefinition !== value)
    return visitDefinition(nestedDefinition, seen);
  for (const item of Object.values(value)) {
    if (visitDefinition(item, seen)) return true;
  }
  return false;
}

function standardIssue(value: StandardSchemaIssue): SchemaIssue {
  return issue(
    value.path?.filter(isPathSegment) ?? [],
    value.code ?? "invalid",
    value.message ?? "Invalid value",
  );
}

function normalizeIssue(value: SchemaIssue): SchemaIssue {
  return issue(
    value.path?.filter(isPathSegment) ?? [],
    value.code ?? "invalid",
    value.message ?? "Invalid value",
  );
}

function issue(path: readonly (string | number)[], code: string, text: string): SchemaIssue {
  return Object.freeze({ path: Object.freeze([...path]), code, message: text });
}

function isPathSegment(value: unknown): value is string | number {
  return typeof value === "string" || typeof value === "number";
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value && typeof value === "object" && typeof (value as { then?: unknown }).then === "function"
  );
}

function synchronousIssue(error: unknown): string {
  const reason = message(error);
  return reason.includes("Promise during synchronous parse")
    ? "Schema validation must be synchronous"
    : reason;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
