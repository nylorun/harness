import type { AgentDefinition } from "../definition/agent-definition.js";
import type { ExecutionState } from "../types/execution.js";
import { copyJson } from "../utils/immutable.js";
import { createId } from "../utils/ids.js";

export function initializeExecutionState(agent: AgentDefinition): ExecutionState {
  return copyJson({
    version: 1,
    agentId: agent.id,
    executionId: createId("execution"),
    revision: 0,
    turnCount: 0,
    transcript: [],
    status: "ready",
    ...(agent.output ? { outputContract: agent.output.schema.jsonSchema } : {}),
  });
}
