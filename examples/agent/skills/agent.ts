import { Agent } from "@nylorun/harness";
import { skills } from "./capability.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Skills are a SKILL.md catalog plus on-demand load_skill. */
export async function createSkills(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
  const agent = Agent({
    id: "skills",
    name: "Skills",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(await skills())
    .with(deps.adapter)
    .build();
  return agent;
}
