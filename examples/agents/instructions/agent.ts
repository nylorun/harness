import { Agent } from "@nylorun/agents/define";
import {
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Constructor instructions only: no tools, skills, or policy. */
export function createInstructions(deps: AgentDependencies): ExampleAgent {
  const agent = Agent({
    id: "instructions",
    name: "Instructions",
    description: "Answers in exactly three short sentences of plain prose, from instructions alone. Has no tools.",
    instructions: [
      "You have no tools. Answer in exactly three short sentences.",
      "Do not use lists, headings, or code fences.",
      "If asked to use a tool or browse the web, say that this agent only answers from its instructions.",
    ],
  })
    .use(modelSelection(deps.provider, deps.model))
    .build();
  return agent;
}
