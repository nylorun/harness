import type { WorkflowBinding, WorkflowManifest } from "../../types/workflow.js";
import type { JsonValue } from "../../types/shared.js";
import type { ToolSchemaSource } from "../../types/tool.js";

/** A workflow built with Chain / Switch / Parallel / Map / Loop. */
export interface BuiltWorkflow<In = JsonValue, Out = JsonValue> {
  readonly id: string;
  readonly manifest: WorkflowManifest;
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
  toJSON(): WorkflowManifest;
  getBinding(): WorkflowBinding;
  /** Phantom type carriers for inference (never present at runtime). */
  readonly __input?: In;
  readonly __output?: Out;
}

export function isBuiltWorkflow(value: unknown): value is BuiltWorkflow {
  return (
    !!value &&
    typeof value === "object" &&
    "manifest" in value &&
    (value as { manifest?: { kind?: unknown } }).manifest?.kind === "workflow" &&
    typeof (value as BuiltWorkflow).getBinding === "function"
  );
}

/** Infer a runnable's output type when known; otherwise JsonValue. */
export type OutputOf<R> = R extends BuiltWorkflow<any, infer O>
  ? O
  : R extends { readonly __output?: infer O }
    ? O
    : R extends { build(): BuiltWorkflow<any, infer O> }
      ? O
      : JsonValue;

export type InputOf<R> = R extends BuiltWorkflow<infer I, any>
  ? I
  : R extends { readonly __input?: infer I }
    ? I
    : JsonValue;
