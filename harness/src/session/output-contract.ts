import { HarnessError, isHarnessError } from "../errors.js";
import { normalizeSchema } from "../build/schema.js";
import type { BoundToolSchema, ToolSchemaSource } from "../types/tool.js";

/** Runtime-only validator paired with the portable JSON Schema projected to models. */
export interface TurnOutputContract {
  readonly schema: BoundToolSchema<unknown>;
}

export function bindOutputContract(source: ToolSchemaSource): TurnOutputContract {
  try {
    return Object.freeze({ schema: normalizeSchema(source, "output") });
  } catch (cause) {
    if (isHarnessError(cause))
      throw new HarnessError("output.invalid-schema", cause.message, { cause });
    throw new HarnessError("output.invalid-schema", String(cause), { cause });
  }
}
