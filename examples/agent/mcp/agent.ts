import { Agent } from "@nylorun/harness";
import { mcpTools } from "./capability.js";
import { LocalMcp } from "./client.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** MCP is a capability backed by an ordinary, host-owned stdio client service. */
export function createMcpAgent(deps: AgentDependencies): ExampleAgent {
  const mcp = new LocalMcp();
  const agent = Agent({
    id: "mcp",
    name: "Local MCP",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(mcpTools(mcp))
    .with(deps.adapter)
    .build();
  return Object.assign(agent, { close: () => mcp.close() });
}
