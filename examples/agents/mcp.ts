import { Agent } from "@nylorun/harness";
import { mcpTools } from "../capabilities/mcp.js";
import { LocalMcp } from "../services/mcp.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "./types.js";

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
  return {
    id: agent.id,
    name: agent.name,
    description: "Discovers and calls a bundled stdio MCP tool.",
    capabilities: ["MCP stdio", "schema-bound tool"],
    agent,
    close: () => mcp.close(),
  };
}
