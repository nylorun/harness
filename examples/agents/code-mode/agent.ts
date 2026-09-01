import { Agent } from "@nylorun/harness";
import { join } from "node:path";
import { approvalFor } from "../../capabilities/review.js";
import { sandboxTools } from "../../capabilities/sandbox.js";
import { skillRoster } from "../../capabilities/skills.js";
import { SkillRoster } from "../../services/skills.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../types.js";

/** Code mode is a transparent composition of inspect, edit, and test tools—no hidden coding-agent process. */
export async function createCodeMode(deps: AgentDependencies): Promise<ExampleAgent> {
  const roster = await SkillRoster.fromDirectory(join(process.cwd(), "skills", "code-mode"));
  const agent = Agent({
    id: "code-mode",
    name: "Docker code mode",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(skillRoster(roster))
    .use(sandboxTools(new Map()))
    .use("review-writes", approvalFor("write_file"))
    .use({
      id: "code-mode",
      instructions: [
        "For code tasks: inspect files, load the code-review skill, propose a minimal edit, wait for approval before write_file, then run_shell to verify it.",
      ],
    })
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description: "A bounded inspect → propose → approve write → test workflow inside Docker.",
    capabilities: ["code workspace", "load_skill", "approval-gated edits", "sandbox tests"],
    requirements: { docker: true },
    agent,
  };
}
