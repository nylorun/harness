import { Agent } from "@nylorun/harness";
import { Run } from "../nylo.local.js";

export default Run((model, directive) => Agent(model, directive), { name: "sample", model: "anthropic/example" });
