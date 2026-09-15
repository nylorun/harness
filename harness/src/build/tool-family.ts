import { normalizeSchema } from "./schema.js";
import { copyJson } from "../utils/immutable.js";
import { HarnessError } from "../errors.js";
import type { JsonValue } from "../types/shared.js";
import type {
  SchemaOutput,
  ToolDefinition,
  ToolExecutionContext,
  ToolOutcome,
  ToolSchemaSource,
} from "../types/tool.js";

type FamilyOutput<S> = S extends ToolSchemaSource ? SchemaOutput<S> : JsonValue;
export interface ToolFamily<
  B extends ToolSchemaSource,
  I extends ToolSchemaSource,
  O extends ToolSchemaSource | undefined = undefined,
  Scope = unknown,
> {
  readonly id: string;
  readonly version: string;
  bind(binding: SchemaOutput<B>): ToolDefinition<I, Scope, O>;
}
interface FamilyOptions<
  B extends ToolSchemaSource,
  I extends ToolSchemaSource,
  O extends ToolSchemaSource | undefined,
  Scope,
> {
  readonly id: string;
  readonly version: string;
  readonly bindingSchema: B;
  readonly describe: (binding: SchemaOutput<B>) => {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: I;
    readonly outputSchema?: O;
  };
  readonly execute: (
    args: SchemaOutput<I>,
    context: ToolExecutionContext<Scope> & { readonly binding: SchemaOutput<B> },
  ) => Promise<ToolOutcome<FamilyOutput<O>>>;
}

export const familyInstances = new WeakMap<
  object,
  { family: ToolFamily<any, any, any, any>; binding: JsonValue }
>();

export function defineToolFamily<
  B extends ToolSchemaSource,
  I extends ToolSchemaSource,
  O extends ToolSchemaSource | undefined = undefined,
  Scope = unknown,
>(options: FamilyOptions<B, I, O, Scope>): ToolFamily<B, I, O, Scope> {
  if (
    typeof options.id !== "string" ||
    !options.id ||
    typeof options.version !== "string" ||
    !options.version
  )
    throw new HarnessError("tool.invalid", "Tool families require a stable id and version");
  if (typeof options.describe !== "function" || typeof options.execute !== "function")
    throw new HarnessError(
      "tool.invalid",
      "Tool families require describe() and execute() functions",
    );
  const schema = normalizeSchema(options.bindingSchema, "input");
  const { describe, execute } = options;
  const family: ToolFamily<B, I, O, Scope> = Object.freeze({
    id: options.id,
    version: options.version,
    bind(value: SchemaOutput<B>) {
      const checked = schema.validate(value);
      if (!checked.ok)
        throw new HarnessError(
          "tool.invalid-binding",
          checked.issues.map((issue) => issue.message).join("; "),
        );
      const binding = copyJson(checked.value) as SchemaOutput<B>;
      const descriptor = describe(binding);
      if (
        !descriptor ||
        typeof descriptor !== "object" ||
        "then" in descriptor ||
        typeof descriptor.name !== "string" ||
        !descriptor.name
      )
        throw new HarnessError(
          "tool.invalid",
          "Family describe() must synchronously return a named tool descriptor",
        );
      const definition: ToolDefinition<I, Scope, O> = Object.freeze({
        ...descriptor,
        execute: (args: SchemaOutput<I>, context: ToolExecutionContext<Scope>) =>
          execute(args, { ...context, binding }),
      });
      familyInstances.set(definition, { family, binding: copyJson(value) as JsonValue });
      return definition;
    },
  });
  return family;
}
