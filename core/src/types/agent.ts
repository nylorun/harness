import type { AgentBinding } from "../definition/binding.js";
import type { AgentManifest } from "./manifest.js";

/** An agent definition composed with Agent(...).use(...). Optional `.build()` is a no-op facade. */
export interface BuiltAgent<Info = unknown, Output = string> {
  readonly id: string;
  readonly name: string;
  readonly manifest: AgentManifest;
  /** Canonical SHA-256 of `manifest` — durable definition identity. */
  readonly hash: string;
  toJSON(): AgentManifest;
  getBinding(): AgentBinding;
}
