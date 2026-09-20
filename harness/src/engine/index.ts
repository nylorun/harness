import type { AgentDefinition } from "../definition/agent-definition.js";
import { definitionFor, tryDefinitionFor } from "../definition/agent-definition.js";
import { checkCompatibility } from "../definition/compatibility.js";
import { agentFrom } from "../definition/from.js";
import type { Implementations } from "../definition/implementations.js";
import { HarnessError } from "../errors.js";
import type { BuiltAgent } from "../types/agent.js";
import type { AgentManifest } from "../types/manifest.js";
import type { ExecutionState, RunOptions, RunResult } from "../types/execution.js";
import { execute } from "../execution/run.js";
import { createExecutionState, validateExecutionState } from "../execution/state.js";
import { initializeExecutionState } from "../execution/initial-state.js";
import { hashManifest } from "../utils/hash.js";

export interface EngineBinding<Info = unknown> {
  readonly manifest: AgentManifest;
  readonly implementations: Implementations<Info>;
  /** Optional live definition — preferred when already assembled. */
  readonly definition?: AgentDefinition;
}

export interface EngineRunOptions<Info = unknown> extends RunOptions<Info> {
  readonly binding: EngineBinding<Info>;
}

/**
 * Run the model/tool loop from a definition binding + optional checkpoint.
 * This is the public engine surface Runtime (and tests) should call.
 */
export async function run<Info = unknown, Output = string>(
  options: EngineRunOptions<Info>,
): Promise<RunResult<Output>> {
  const definition = resolveDefinition(options.binding as EngineBinding);
  if (options.state?.manifestHash) {
    const compatibility = checkCompatibility(definition.manifest, options.state);
    if (!compatibility.ok) throw compatibility.error;
  }
  const { binding: _, ...runOptions } = options;
  return execute(definition, runOptions) as Promise<RunResult<Output>>;
}

/** Create a fresh checkpoint bound to a manifest hash. */
export function createEngineState(
  binding: EngineBinding,
  options?: {
    readonly executionId?: string;
    readonly state?: import("../types/shared.js").JsonObject;
  },
): ExecutionState {
  const definition = resolveDefinition(binding);
  return initializeExecutionState(definition, options);
}

function resolveDefinition(binding: EngineBinding): AgentDefinition {
  if (binding.definition) return binding.definition;
  const agent = agentFrom(binding.manifest, binding.implementations);
  return definitionFor(agent);
}

/** Build an engine binding from a live agent (1.0 bridge). */
export function bindingFromAgent(agent: BuiltAgent): EngineBinding {
  const definition = tryDefinitionFor(agent);
  if (!definition)
    throw new HarnessError(
      "execution.invalid-input",
      "bindingFromAgent requires an agent from Agent(...) or Agent.from(...)",
    );
  return {
    manifest: definition.manifest,
    implementations: definition.implementations,
    definition,
  };
}

export { checkCompatibility, createExecutionState, validateExecutionState, hashManifest, execute };

export type { AgentDefinition, Implementations, ExecutionState, RunResult, RunOptions };

export { createHostedCheckpoint, runHosted } from "./hosted.js";
export type {
  HostedCheckpoint,
  HostEffect,
  EffectResolution,
  EngineHost,
  HostedResult,
} from "./hosted.js";
export type { ModelAdapter, ModelCandidate, ModelCall, ModelRequest } from "../types/model.js";
