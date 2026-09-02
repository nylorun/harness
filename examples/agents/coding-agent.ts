import { Agent } from "@nylorun/harness";
import { codexTools } from "../capabilities/codex.js";
import { approvalFor } from "../capabilities/review.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "./types.js";

/** Coding work is handed to the host-installed Codex CLI in a temporary workspace. */
export function createCodingAgent(deps: AgentDependencies): ExampleAgent {
  const agent = Agent({
    id: "coding-agent",
    name: "Coding Agent",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(codexTools(new Map()))
    .use("review-codex", approvalFor("codex_exec"))
    .use({
      id: "coding-agent",
      instructions: [
        "For coding tasks, ask for approval then call codex_exec. Report Codex stdout. The workspace is a temporary directory, not this repository.",
      ],
    })
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description: "Runs coding tasks with the host Codex CLI in an isolated temporary workspace.",
    capabilities: ["codex exec", "candidate review"],
    requirements: { codex: true },
    agent,
  };
}
