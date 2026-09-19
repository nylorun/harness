import type { AgentManifest } from "./manifest.js";
import type { RunOptions, RunResult } from "./execution.js";

/** An agent definition composed with Agent(...).use(...). Optional `.build()` is a no-op facade. */
export interface BuiltAgent<Info = unknown, Output = string> {
  readonly id: string;
  readonly name: string;
  readonly manifest: AgentManifest;
  /** Canonical SHA-256 of `manifest` — durable definition identity. */
  readonly hash: string;
  toJSON(): AgentManifest;
  /** @deprecated Taught path is Runtime sessions / `@nylorun/harness/engine`. Alias through 1.0. */
  run(options: RunOptions<Info>): Promise<RunResult<Output>>;
}
