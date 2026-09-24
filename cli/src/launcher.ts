import { runProject } from "./project-runner.js";

export async function serve(
  entry = "dist/agents/index.js",
  options: { autostart?: boolean; ephemeral?: boolean } = {},
): Promise<void> {
  await runProject(entry, options);
}
