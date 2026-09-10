import { Agent } from "@nylorun/harness";
import { approvalFor } from "../interactions/approval.js";
import { sandboxTools } from "./capability.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Docker is an infrastructure service; this agent only declares its visible tools and policy. */
export function createSandbox(deps: AgentDependencies): ExampleAgent {
  const agent = Agent({
    id: "sandbox",
    name: "Sandbox",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(sandboxTools(new Map()))
    .use("review-writes", approvalFor("write_file"))
    .with(deps.adapter)
    .build();
  return agent;
}
