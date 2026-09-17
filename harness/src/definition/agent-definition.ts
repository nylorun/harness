import type { BoundMiddleware } from "./bound.js";
import type { ToolRegistry } from "./registry.js";
import type { TurnOutputContract } from "./output-contract.js";
import { HarnessError } from "../errors.js";

export interface AgentDefinition {
  readonly id: string;
  readonly middleware: readonly BoundMiddleware[];
  readonly registry: ToolRegistry;
  readonly output?: TurnOutputContract;
}

// Definition lookup only; execution progress is never retained here.
const definitions = new WeakMap<object, AgentDefinition>();
export function registerDefinition(agent: object, definition: AgentDefinition): void {
  definitions.set(agent, definition);
}
export function definitionFor(agent: object): AgentDefinition {
  const definition = definitions.get(agent);
  if (!definition)
    throw new HarnessError(
      "execution.invalid-input",
      "createExecutionState() requires the original agent returned by Agent(...).build(); initialize wrapper state with that original agent.",
    );
  return definition;
}
