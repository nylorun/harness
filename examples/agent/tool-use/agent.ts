import { Agent } from "@nylorun/harness";
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
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(await tools())
    .with(deps.adapter)
    .build();
  return agent;
}
