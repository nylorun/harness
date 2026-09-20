import { z } from "zod";
import { defineSchema } from "./schema.js";
import type { JsonObject } from "../types/shared.js";
/** Unsupported JSON Schema constructs fail closed during definition loading. */
export function schemaFromJSON(jsonSchema: JsonObject) {
  const schema = z.fromJSONSchema(jsonSchema);
  return defineSchema({
    jsonSchema,
    validate(value: unknown) {
      const result = schema.safeParse(value);
      return result.success
        ? { ok: true as const, value: result.data }
        : {
            ok: false as const,
            issues: result.error.issues.map((issue) => ({
              path: issue.path.filter(
                (v): v is string | number => typeof v === "string" || typeof v === "number",
              ),
              code: issue.code,
              message: issue.message,
            })),
          };
    },
  });
}
