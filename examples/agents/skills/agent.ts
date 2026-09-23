import { Agent } from "@nylorun/agents/define";
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
    description: "Loads a SKILL.md procedure, such as a code review or a structured summary, and follows it.",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(await skills())
    .build();
  return agent;
}
