import { Agent } from "@nylorun/harness";
import { codeMode } from "../capabilities/code-mode.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "./types.js";

/** Code mode presents the tools catalog as a generated SDK; only run_code is callable directly. */
export async function createCodeMode(deps: AgentDependencies): Promise<ExampleAgent> {
  const agent = Agent({
    id: "code-mode",
    name: "Code Mode",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(await codeMode())
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description:
      "Same calculate, convert, and now tools as Tool Use, collapsed to one run_code program.",
    capabilities: ["run_code", "programmatic calculate", "programmatic convert", "programmatic now"],
    agent,
  };
}
