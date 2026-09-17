import type { AgentDefinition } from "../definition/agent-definition.js";
import type { BoundToolDefinition } from "../definition/bound.js";
import { initializeExecutionState } from "./initial-state.js";
import { canonical } from "../utils/canonical.js";
import { HarnessError } from "../errors.js";
import type { ExecutionState, RunOptions } from "../types/execution.js";
import { normalizeInput, validateExecutionState } from "./state.js";

const acceptedOptions = new Set([
  "state",
  "input",
  "onModelCall",
  "info",
  "signal",
  "onEvent",
  "record",
]);

export function validateRunOptions(options: RunOptions<any>): void {
  if (!options || typeof options.onModelCall !== "function")
    throw new HarnessError("execution.invalid-input", "run() requires input and onModelCall");
  for (const key of Object.keys(options))
    if (!acceptedOptions.has(key))
      throw new HarnessError("execution.invalid-input", `Unknown run option '${key}'`);
  for (const key of ["record", "onEvent"] as const)
    if (options[key] !== undefined && typeof options[key] !== "function")
      throw new HarnessError("execution.invalid-input", `${key} must be a function`);
  if (
    options.signal !== undefined &&
    (!options.signal ||
      typeof options.signal.throwIfAborted !== "function" ||
      typeof options.signal.addEventListener !== "function")
  )
    throw new HarnessError("execution.invalid-input", "signal must be an AbortSignal");
}

export function openExecution(
  agent: AgentDefinition,
  options: RunOptions<any>,
): {
  readonly state: ExecutionState;
  readonly input: ReturnType<typeof normalizeInput>;
  readonly definitions: Map<string, BoundToolDefinition>;
} {
  const state =
    options.state === undefined
      ? initializeExecutionState(agent)
      : validateExecutionState(options.state);
  if (
    state.agentId !== agent.id ||
    canonical(state.outputContract) !== canonical(agent.output?.schema.jsonSchema)
  )
    throw new HarnessError(
      "execution.incompatible",
      "Saved state requires the original compatible agent and outputSchema",
    );
  if (
    (state.status !== "paused" && state.plan !== undefined) ||
    state.status === "active" ||
    state.plan?.calls.some((call) => call.status === "active")
  )
    throw new HarnessError(
      "execution.invalid-state",
      "Execution was interrupted with possibly active effects. Reconcile it before starting another run; automatic replay is not supported.",
    );
  const definitions = new Map<string, BoundToolDefinition>();
  for (const call of state.plan?.calls ?? []) {
    const definition = agent.registry.restore(call.reference);
    const validation = definition.inputSchema.validate(call.rawArgs);
    if (!validation.ok || canonical(validation.value) !== canonical(call.args))
      throw new HarnessError(
        "execution.incompatible",
        "Saved tool arguments differ from their accepted contract",
      );
    definitions.set(call.invocationId, definition);
  }
  return { state, input: normalizeInput(options.input), definitions };
}
