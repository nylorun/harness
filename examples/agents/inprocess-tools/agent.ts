import { Agent } from "@nylorun/harness";
import { join } from "node:path";
import { calculator } from "../../capabilities/calculator.js";
import { notes } from "../../capabilities/notes.js";
import { approvalFor } from "../../capabilities/review.js";
import { JsonlNotes } from "../../services/notes-jsonl.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../types.js";

/** In-process capability composition: pure calculator + explicit JSONL notes service. */
export function createInprocessTools(deps: AgentDependencies): ExampleAgent {
  const store = new JsonlNotes(join(deps.dataRoot, "inprocess-tools", "notes.jsonl"));
  const agent = Agent({
    id: "inprocess-tools",
    name: "In-process tools",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(calculator)
    .use(notes(store))
    .use("review-writes", approvalFor("write_note"))
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description: "Calculator and approval-gated JSONL notes with no external runtime.",
    capabilities: ["calculator", "notes", "candidate review"],
    agent,
  };
}
