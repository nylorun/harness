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

/** Skills are Markdown data plus per-session Harness state; Docker remains a separate service. */
export async function createDockerSkills(deps: AgentDependencies): Promise<ExampleAgent> {
  const roster = await SkillRoster.fromDirectory(join(process.cwd(), "skills", "docker-skills"));
  const agent = Agent({
    id: "docker-skills",
    name: "Docker skills",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(skillRoster(roster))
    .use(sandboxTools(new Map()))
    .use("review-writes", approvalFor("write_file"))
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description: "Loads a local Markdown skill into session context before using Docker tools.",
    capabilities: ["load_skill", "per-session instructions", "sandbox shell"],
    requirements: { docker: true },
    agent,
  };
}
