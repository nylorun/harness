import { Agent } from "@nylorun/harness";
import { delegateTo } from "../capabilities/subagents.js";
import { createInstructions } from "./instructions.js";
import { createSkills } from "./skills.js";
import { createToolUse } from "./tool-use.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "./types.js";

/** A parent agent that delegates to the Instructions, Skills, and Tool Use examples. */
export async function createSubagents(deps: AgentDependencies): Promise<ExampleAgent> {
  const [instructions, skills, toolUse] = await Promise.all([
    createInstructions(deps),
    createSkills(deps),
    createToolUse(deps),
  ]);
  const agent = Agent({
    id: "subagents",
    name: "Subagents",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(
      delegateTo({
        instructions: instructions.agent,
        skills: skills.agent,
        "tool-use": toolUse.agent,
      }),
    )
    .use({
      id: "coordinator",
      instructions: [
        "Do not do specialist work yourself. Delegate each task to the matching specialist.",
        "instructions: format-constrained prose with no tools.",
        "skills: load and follow a SKILL.md procedure.",
        "tool-use: calculate, now, or convert.",
      ],
    })
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description:
      "Coordinates the Instructions, Skills, and Tool Use example agents through a delegate tool.",
    capabilities: ["delegate", "instructions", "skills", "tool-use"],
    agent,
  };
}
