import type { AgentManifest } from "../types/manifest.js";
import type { BoundMiddleware } from "../types/middleware.js";
import type { ModelAdapter } from "../types/model.js";
import type { RunOptions, RunResult } from "../types/execution.js";
import type { ToolSchemaSource } from "../types/tool.js";
import { bindOutputContract, type TurnOutputContract } from "../execution/output-contract.js";
import { ToolRegistry } from "./registry.js";
import { execute } from "../execution/run.js";

export interface LoopAgent {
  readonly middleware: readonly BoundMiddleware[];
  readonly invoke: ModelAdapter;
  readonly registry: ToolRegistry;
}

export class BuiltAgent<Scope = unknown, Output = string> {
  readonly id: string;
  readonly name: string;
  readonly executionVersion: string;
  readonly registry: ToolRegistry;
  readonly output?: TurnOutputContract;

  constructor(
    readonly middleware: readonly BoundMiddleware[],
    readonly manifest: AgentManifest,
    options: { executionVersion?: string; outputSchema?: ToolSchemaSource } = {},
  ) {
    this.id = manifest.id;
    this.name = manifest.name;
    this.executionVersion = options.executionVersion ?? "1";
    this.registry = new ToolRegistry(middleware);
    this.output =
      options.outputSchema === undefined ? undefined : bindOutputContract(options.outputSchema);
  }

  run(options: RunOptions<Scope>): Promise<RunResult<Output>> {
    return execute(this, options) as Promise<RunResult<Output>>;
  }
}

export function bindAgent(
  middleware: readonly BoundMiddleware[],
  manifest: AgentManifest,
  options: { executionVersion?: string; outputSchema?: ToolSchemaSource } = {},
): BuiltAgent {
  return new BuiltAgent(middleware, manifest, options);
}
