import { defineRuntime, localJsonl } from "@nylorun/runtime";
import { agents, media } from "./agent/registry.js";

export default defineRuntime({ agents, persistence: localJsonl(), media });
