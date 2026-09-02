import { Agent } from "@nylorun/harness";
import {
  inputGuardrail,
  lookup,
  outputGuardrail,
  publish,
  toolInputGuardrail,
  toolOutputGuardrail,
} from "../capabilities/guardrails.js";
import { tools } from "../capabilities/tools/index.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "./types.js";

/** Input, output, tool-input, and tool-output policy around publish and lookup. */
export async function createGuardrails(deps: AgentDependencies): Promise<ExampleAgent> {
  const agent = Agent({
    id: "guardrails",
    name: "Guardrails",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(await tools())
    .use(publish)
    .use(lookup)
    .use("input", inputGuardrail)
    .use("output", outputGuardrail)
    .use("tool-input", toolInputGuardrail)
    .use("tool-output", toolOutputGuardrail)
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description:
      "Input, output, tool-input, and tool-output policy around publish and lookup.",
    capabilities: [
      "input",
      "output",
      "tool-input",
      "tool-output",
      "publish",
      "lookup",
      "calculate",
    ],
    agent,
  };
}
