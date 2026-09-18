import type { AgentManifest } from "./manifest.js";
import type { RunOptions, RunResult } from "./execution.js";

/** An agent definition built with Agent(...).use(...).build(). */
export interface BuiltAgent<Info = unknown, Output = string> {
  readonly id: string;
  readonly name: string;
  readonly manifest: AgentManifest;
  run(options: RunOptions<Info>): Promise<RunResult<Output>>;
}
