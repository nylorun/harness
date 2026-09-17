import { HarnessError, isHarnessError } from "../errors.js";
import { normalizeSchema } from "./schema.js";
import type { ToolSchema, ToolSchemaSource } from "../types/tool.js";

/** Runtime-only validator paired with the portable JSON Schema projected to models. */
export interface TurnOutputContract {
  readonly schema: ToolSchema<unknown>;
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
