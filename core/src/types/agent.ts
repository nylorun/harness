import type { AgentBinding } from "../definition/binding.js";
import type { AgentManifest } from "./manifest.js";

/** An agent definition composed with Agent(...).use(...). Optional `.build()` is a no-op facade. */
export interface BuiltAgent<Info = unknown, Output = string> {
  readonly id: string;
  readonly name?: string;
  readonly manifest: AgentManifest;
  toJSON(): AgentManifest;
  getBinding(): AgentBinding;
}
