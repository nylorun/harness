import type { AgentManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "./bound.js";
import type { BuiltAgent } from "../types/agent.js";
import type { RunOptions, RunResult } from "../types/execution.js";
import type { ToolSchemaSource } from "../types/tool.js";
import { bindOutputContract } from "./output-contract.js";
import { registerDefinition, type AgentDefinition } from "./agent-definition.js";
import { ToolRegistry } from "./registry.js";

export function bindAgent(
  middleware: readonly BoundMiddleware[],
  manifest: AgentManifest,
  options: { outputSchema?: ToolSchemaSource } = {},
  run: (definition: AgentDefinition, options: RunOptions<any>) => Promise<RunResult<any>>,
): BuiltAgent {
  const definition: AgentDefinition = Object.freeze({
    id: manifest.id,
    middleware,
    registry: new ToolRegistry(middleware),
    ...(options.outputSchema === undefined
      ? {}
      : { output: bindOutputContract(options.outputSchema) }),
  });
  const agent: BuiltAgent = {
    id: definition.id,
    name: manifest.name,
    manifest,
    run: (options) => run(definition, options) as ReturnType<BuiltAgent["run"]>,
  };
  registerDefinition(agent, definition);
  return agent;
}
