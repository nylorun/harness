import type { AgentTool, BuiltAgent } from "../../types/agent.js";
import type { JsonValue } from "../../types/shared.js";
import type {
  Verdict,
  WorkflowBinding,
  WorkflowManifest,
  WorkflowNodeImplementation,
} from "../../types/workflow.js";
import { bindingFromAgent } from "../binding.js";
import type { BuiltWorkflow } from "./types.js";

/** Arguments passed to a Loop verify function. */
export type LoopVerifyArgs = {
  readonly input: JsonValue;
  readonly output: JsonValue;
  readonly iteration: number;
};

/** Arguments passed to a Loop decide function. */
export type LoopDecideArgs = {
  readonly agent?: import("../../types/manifest.js").AgentManifest;
  readonly output: JsonValue;
  readonly verdict: Verdict;
  readonly iteration: number;
  readonly input: JsonValue;
  readonly history: readonly {
    readonly iteration: number;
    readonly output: JsonValue;
    readonly verdict: Verdict;
  }[];
};

export type LoopDecision =
  | { readonly input: JsonValue; readonly agent?: import("../../types/manifest.js").AgentManifest }
  | { readonly output: JsonValue };

export type LoopVerifyFn = (
  args: LoopVerifyArgs,
  ctx?: unknown,
) => Verdict | Promise<Verdict>;

export type LoopDecideFn = (args: LoopDecideArgs) => LoopDecision;

export type LoopRunnable = BuiltAgent | AgentTool | { build(): BuiltAgent };

export interface LoopOptions {
  readonly id: string;
  readonly run: LoopRunnable;
  readonly verify: LoopVerifyFn;
  readonly decide: LoopDecideFn;
}

function builtAgentOf(run: LoopRunnable): BuiltAgent {
  if (
    run &&
    typeof run === "object" &&
    "getBinding" in run &&
    typeof run.getBinding === "function" &&
    "manifest" in run
  )
    return run as BuiltAgent;
  if (run && typeof run === "object" && "build" in run && typeof run.build === "function")
    return run.build();
  throw new Error("Loop.run must be a built agent or Agent builder");
}

/**
 * Build a root Loop workflow: run → verify → decide, repeating until decide returns output.
 * Tracer-minimal: `run` is an agent; verify and decide are local functions.
 */
export function Loop(options: LoopOptions): BuiltWorkflow {
  const { id, verify, decide } = options;
  if (!id) throw new Error("Loop requires id");
  if (!options.run) throw new Error("Loop requires run");
  if (!verify) throw new Error("Loop requires verify");
  if (!decide) throw new Error("Loop requires decide");

  const agent = builtAgentOf(options.run);
  const agentBinding = bindingFromAgent(agent);
  const agentId = agent.id;

  const manifest: WorkflowManifest = {
    kind: "workflow",
    workflowSchemaVersion: 1,
    id,
    root: {
      loop: {
        id,
        run: { agent: agentId },
        verify: { fn: true },
        decide: { fn: true },
      },
    },
  };

  // Verify and decide share the loop path; keys distinguish them for the executor.
  const nodes: Record<string, WorkflowNodeImplementation> = {
    [id]: { kind: "verify", fn: verify as (...args: never[]) => unknown },
    [`${id}/decide`]: { kind: "fn", fn: decide as (...args: never[]) => unknown },
  };

  const binding: WorkflowBinding = {
    manifest,
    nodes,
    agents: { [agentId]: agentBinding },
  };

  const built: BuiltWorkflow = {
    id,
    manifest,
    toJSON: () => manifest,
    getBinding: () => binding,
  };
  return built;
}
