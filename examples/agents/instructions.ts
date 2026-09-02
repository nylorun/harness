import { Agent } from "@nylorun/harness";
import { modelSelection, type AgentDependencies, type ExampleAgent } from "./types.js";

/** Constructor instructions only: no tools, skills, or policy. */
export function createInstructions(deps: AgentDependencies): ExampleAgent {
  const agent = Agent({
    id: "instructions",
    name: "Instructions",
    instructions: [
      "You have no tools. Answer in exactly three short sentences.",
      "Do not use lists, headings, or code fences.",
      "If asked to use a tool or browse the web, say that this agent only answers from its instructions.",
    ],
  })
    .use(modelSelection(deps.provider, deps.model))
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description: "A model with constructor instructions and no tools.",
    capabilities: ["instructions"],
    agent,
  };
}
