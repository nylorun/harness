import { connectAgents } from "@nylorun/agents";
import { agents } from "../agents/index.js";

await connectAgents({ agents }).ready;
