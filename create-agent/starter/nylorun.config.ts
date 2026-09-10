import { defineRuntime } from "@nylorun/runtime";
import { agents } from "./agent/registry.js";

export default defineRuntime({ agents });
