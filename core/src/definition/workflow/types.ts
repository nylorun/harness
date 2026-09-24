import type { WorkflowBinding, WorkflowManifest } from "../../types/workflow.js";

/** A workflow built with `Loop(...)` (and later Chain/Switch/…). */
export interface BuiltWorkflow {
  readonly id: string;
  readonly manifest: WorkflowManifest;
  toJSON(): WorkflowManifest;
  getBinding(): WorkflowBinding;
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
