import { Agent } from "@nylorun/agents/define";
import { tools } from "../shared/tools/index.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** In-process tool loop with no policy or human approval. */
export async function createToolUse(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
  const agent = Agent({
    id: "tool-use",
    name: "Tool Use",
    description: "Calculates, reports the current time, and converts units with tools. Returns the result.",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(await tools())
    .build();
  return agent;
}
