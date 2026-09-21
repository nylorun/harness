import { runProject } from "./project-runner.js";
export async function start(entry = "dist/agents/index.js"): Promise<void> {
  await runProject(entry);
}
