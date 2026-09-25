import type { JsonValue } from "../../types/shared.js";
import type { WorkflowRunnable } from "./runnable.js";

/**
 * Arguments for a slot `input` reshape function (workflows.md §4).
 * `results` comes from the nearest enclosing Chain; `index` only in Map `each`.
 */
export type SlotInputArgs<
  Value = JsonValue,
  Input = JsonValue,
  Results extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>,
> = {
  readonly value: Value;
  readonly input: Input;
  readonly results: Results;
  readonly index?: number;
};

/**
 * Plain-object rename/reshape wrapper. There is no helper constructor —
 * write `{ run, id?, input? }` (workflows.md §4, decision 5).
 */
export type Slot<
  Run extends WorkflowRunnable = WorkflowRunnable,
  Value = JsonValue,
  Input = JsonValue,
  Results extends Readonly<Record<string, JsonValue>> = Readonly<Record<string, JsonValue>>,
> = {
  readonly run: Run;
  readonly id?: string;
  readonly input?: (args: SlotInputArgs<Value, Input, Results>) => JsonValue;
};

export type ChildRef<Run extends WorkflowRunnable = WorkflowRunnable> = Run | Slot<Run>;

export function isSlot(value: unknown): value is Slot {
  if (!value || typeof value !== "object") return false;
  if (!("run" in value)) return false;
  // Agents / workflows expose manifest + getBinding; tools expose name + execute/run.
  if ("manifest" in value || "getBinding" in value) return false;
  if (
    "name" in value &&
    (typeof (value as { execute?: unknown }).execute === "function" ||
      typeof (value as { run?: unknown }).run === "function" ||
      "inputSchema" in value ||
      "input" in value)
  )
    return false;
  return true;
}
