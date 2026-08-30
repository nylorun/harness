import { Agent } from "@nylorun/harness";
import { mcpTools } from "../../capabilities/mcp.js";
import { LocalMcp } from "../../services/mcp.js";
import { modelSelection, type AgentDependencies, type ExampleAgent } from "../types.js";

/** MCP is a capability backed by an ordinary, host-owned stdio client service. */
export function createMcpAgent(deps: AgentDependencies): ExampleAgent {
  const mcp = new LocalMcp();
  return {
    id: "mcp",
    name: "Local MCP",
    description: "Discovers and calls a bundled stdio MCP tool.",
    capabilities: ["MCP stdio", "schema-bound tool"],
    agent: Agent(deps.adapter)
      .use(modelSelection(deps.provider, deps.model))
      .use(mcpTools(mcp))
      .build(),
    close: () => mcp.close(),
  };
}
