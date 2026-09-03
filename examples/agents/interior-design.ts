import { Agent } from "@nylorun/harness";
import { interiorDesign } from "../capabilities/interior-design.js";
import {
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "./types.js";

/** Multimodal image-editing agent backed by a host-owned OpenAI Images service. */
export function createInteriorDesign(deps: AgentDependencies): ExampleAgent {
  const agent = Agent({
    id: "interior-design",
    name: "Interior Design",
    instructions: [
      "You are an interior designer who turns room photos into redesigned visual concepts.",
      "Require a room photo and a theme. Ask for a theme when it is missing, then use the image-editing tool.",
      "After the tool completes, summarize the design choices in two concise sentences.",
    ],
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(interiorDesign(deps.media, deps.imageEditor))
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description:
      "Redesigns an uploaded room photo around a requested interior design theme.",
    capabilities: ["image-input", "interior-design", "openai-image-edit"],
    agent,
  };
}
