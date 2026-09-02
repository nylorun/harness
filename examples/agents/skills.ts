import { Agent } from "@nylorun/harness";
import { skills } from "../capabilities/skills/index.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "./types.js";

/** Skills are a SKILL.md catalog plus on-demand load_skill. */
export async function createSkills(deps: AgentDependencies): Promise<ExampleAgent> {
  const agent = Agent({
    id: "skills",
    name: "Skills",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(await skills())
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description: "Loads a local SKILL.md procedure through load_skill.",
    capabilities: ["load_skill"],
    agent,
  };
}
