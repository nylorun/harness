import { Agent } from "@nylorun/harness";
import { join } from "node:path";
import { askUser } from "./ask-user.js";
import { notes } from "./notes.js";
import { approvalFor } from "./approval.js";
import { JsonlNotes } from "./notes-store.js";
import {
  exampleInstructions,
  modelSelection,
  type AgentDependencies,
  type ExampleAgent,
} from "../shared/types.js";

/** Human-in-the-loop: approval-gated writes and response questions. */
export function createInteractions(deps: AgentDependencies): ExampleAgent {
  const store = new JsonlNotes(
    join(deps.dataRoot, "interactions", "notes.jsonl"),
  );
  const agent = Agent({
    id: "interactions",
    name: "Interactions",
    instructions: exampleInstructions,
  })
    .use(modelSelection(deps.provider, deps.model))
    .use(notes(store))
    .use(askUser)
    .use("review-writes", approvalFor("write_note"))
    .build();
  return agent;
}
