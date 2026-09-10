import { Agent } from "@nylorun/harness";
import { delegateTo } from "./capability.js";
import { createInstructions } from "../instructions/agent.js";
import { createSkills } from "../skills/agent.js";
import { createToolUse } from "../tool-use/agent.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** A parent agent that delegates to the Instructions, Skills, and Tool Use examples. */
export async function createSubagents(
  deps: AgentDependencies,
): Promise<ExampleAgent> {
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
        instructions: instructions,
        skills: skills,
        "tool-use": toolUse,
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
  return agent;
}
