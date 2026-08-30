import { join } from "node:path";
import { createPiAdapter, providerConfig } from "../services/pi.js";
import { createCodeMode } from "../agents/code-mode/agent.js";
import { createDockerSkills } from "../agents/docker-skills/agent.js";
import { createDockerWorkspace } from "../agents/docker-workspace/agent.js";
import { createInprocessTools } from "../agents/inprocess-tools/agent.js";
import { createMcpAgent } from "../agents/mcp/agent.js";
import type { ExampleAgent } from "../agents/types.js";
import type { ModelAdapter } from "@nylorun/harness";

export async function createRegistry(
  root: string,
  override:
    Readonly<{ adapter: ModelAdapter; provider: string; model: string }> | undefined = undefined,
): Promise<readonly ExampleAgent[]> {
  const config = override ?? providerConfig();
  const deps = {
    adapter: "adapter" in config ? config.adapter : await createPiAdapter(config),
    provider: config.provider,
    model: config.model,
    dataRoot: join(root, ".data"),
  };
  return Object.freeze([
    createInprocessTools(deps),
    createMcpAgent(deps),
    createDockerWorkspace(deps),
    await createDockerSkills(deps),
    await createCodeMode(deps),
  ]);
}
