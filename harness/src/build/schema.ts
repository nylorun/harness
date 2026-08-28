import { z } from "zod";
import type { output } from "zod";
import { HarnessError } from "../errors.js";
import type { ToolObjectSchema } from "../types/tool.js";
import { copyJsonObject } from "../utils/immutable.js";

export type SchemaValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly string[] };

export interface NormalizedToolSchema<T> {
  readonly jsonSchema: import("../types/shared.js").JsonObject;
  validate(value: unknown): SchemaValidation<T>;
}

/** Converts a synchronous Zod object schema into Harness's immutable runtime representation. */
export function normalizeSchema<Parameters extends ToolObjectSchema>(
  parameters: Parameters,
): NormalizedToolSchema<output<Parameters>> {
  if (!(parameters instanceof z.ZodObject)) {
    throw new HarnessError(
      "tool.invalid-schema",
      "Tool parameters schema must be a Zod object schema",
    );
  }
  if (hasDeclaredAsyncWork(parameters)) {
    throw new HarnessError(
      "tool.invalid-schema",
      "Tool parameters schema must validate synchronously",
    );
  }

  let jsonSchema: import("../types/shared.js").JsonObject;
  try {
    jsonSchema = copyJsonObject(
      z.toJSONSchema(parameters, { target: "draft-07" }),
      "tool.parameters.jsonSchema",
    );
  } catch (error) {
    throw new HarnessError(
      "tool.invalid-schema",
      `Tool parameters schema must convert to JSON Schema: ${message(error)}`,
      { cause: error },
    );
  }
  if (jsonSchema.type !== "object") {
    throw new HarnessError("tool.invalid-schema", "Tool JSON Schema root type must be object");
  }

  return Object.freeze({
    jsonSchema,
    validate(value: unknown): SchemaValidation<output<Parameters>> {
      try {
        const result = parameters.safeParse(value);
        if (result.success) return { ok: true, value: result.data };
        return {
          ok: false,
          issues: result.error.issues.map(
            (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
          ),
        };
      } catch (error) {
        return { ok: false, issues: [synchronousIssue(error)] };
      }
    },
  });
}

/** Zod exposes declared checks in its stable v4 definition graph; reject async checks before a run. */
function hasDeclaredAsyncWork(schema: ToolObjectSchema): boolean {
  return visitDefinition((schema as unknown as { _zod?: { def?: unknown } })._zod?.def, new Set());
}

function visitDefinition(value: unknown, seen: Set<object>): boolean {
  if (typeof value === "function") return value.constructor.name === "AsyncFunction";
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  // Nested Zod schemas carry their own definition graph. Inspect it directly so public helpers
  // such as `parseAsync` do not make every otherwise-synchronous schema look asynchronous.
  const nestedDefinition = (value as { _zod?: { def?: unknown } })._zod?.def;
  if (nestedDefinition !== undefined && nestedDefinition !== value)
    return visitDefinition(nestedDefinition, seen);

  for (const item of Object.values(value)) {
    if (visitDefinition(item, seen)) return true;
  }
  return false;
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
