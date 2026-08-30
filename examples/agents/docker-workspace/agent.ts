import { Agent } from "@nylorun/harness";
import { approvalFor } from "../../capabilities/review.js";
import { sandboxTools } from "../../capabilities/sandbox.js";
import { modelSelection, type AgentDependencies, type ExampleAgent } from "../types.js";

/** Docker is an infrastructure service; this agent only declares its visible tools and policy. */
export function createDockerWorkspace(deps: AgentDependencies): ExampleAgent {
  return {
    id: "docker-workspace",
    name: "Docker workspace",
    description:
      "Filesystem and shell tools in a resource-limited, network-disabled Docker workspace.",
    capabilities: ["sandbox filesystem", "sandbox shell", "candidate review"],
    requirements: { docker: true },
    agent: Agent(deps.adapter)
      .use(modelSelection(deps.provider, deps.model))
      .use(sandboxTools(new Map()))
      .use("review-writes", approvalFor("write_file"))
      .build(),
  };
}
