import { runProject } from "./project-runner.js";
import type { Scope } from "./scope.js";
export async function serve(
  entry = "dist/agents/index.js",
  options: { autostart?: boolean; scope?: Scope } = {}
): Promise<void> {
  await runProject(entry, options);
}
