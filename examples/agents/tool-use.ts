import { Agent } from "@nylorun/harness";
import { tools } from "../capabilities/tools/index.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "./types.js";

/** In-process tool loop with no policy or human approval. */
export async function createToolUse(deps: AgentDependencies): Promise<ExampleAgent> {
  const agent = Agent({
    id: "tool-use",
    name: "Tool Use",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(await tools())
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description: "In-process calculate, now, and convert tools with no approval or external runtime.",
    capabilities: ["calculate", "now", "convert"],
    agent,
  };
}
