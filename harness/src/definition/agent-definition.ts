import type { BoundMiddleware } from "./bound.js";
import type { ToolRegistry } from "./registry.js";
import type { TurnOutputContract } from "./output-contract.js";
import type { AgentManifest } from "../types/manifest.js";
import type { Implementations } from "./implementations.js";
import { HarnessError } from "../errors.js";

export interface AgentDefinition {
  readonly id: string;
  readonly middleware: readonly BoundMiddleware[];
  readonly registry: ToolRegistry;
  readonly output?: TurnOutputContract;
  readonly manifest: AgentManifest;
  readonly hash: string;
  readonly implementations: Implementations;
}

export type { Implementations };

// Live agent → definition cache. Identity for resume is manifest hash, not this map.
const definitions = new WeakMap<object, AgentDefinition>();
export function registerDefinition(agent: object, definition: AgentDefinition): void {
  definitions.set(agent, definition);
}
export function definitionFor(agent: object): AgentDefinition {
  const definition = definitions.get(agent);
  if (!definition)
    throw new HarnessError(
      "execution.invalid-input",
      "createExecutionState() requires an agent from Agent(...) or Agent.from(...); initialize wrapper state with that original agent.",
    );
  return definition;
}
export function tryDefinitionFor(agent: object): AgentDefinition | undefined {
  return definitions.get(agent);
}
