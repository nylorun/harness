import { Agent } from "@nylorun/harness";
import { codexTools } from "./capability.js";
import { approvalFor } from "../interactions/approval.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

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
    .build();
  return agent;
}
