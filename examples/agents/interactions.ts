import { Agent } from "@nylorun/harness";
import { join } from "node:path";
import { askUser } from "../capabilities/ask-user.js";
import { notes } from "../capabilities/notes.js";
import { approvalFor } from "../capabilities/review.js";
import { JsonlNotes } from "../services/notes-jsonl.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "./types.js";

/** Human-in-the-loop: approval-gated writes and response questions. */
export function createInteractions(deps: AgentDependencies): ExampleAgent {
  const store = new JsonlNotes(join(deps.dataRoot, "interactions", "notes.jsonl"));
  const agent = Agent({
    id: "interactions",
    name: "Interactions",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(notes(store))
    .use(askUser)
    .use("review-writes", approvalFor("write_note"))
    .with(deps.adapter)
    .build();
  return {
    id: agent.id,
    name: agent.name,
    description: "Asks the human to approve writes and answer questions before continuing.",
    capabilities: ["notes", "ask_user", "approval", "response"],
    agent,
  };
}
