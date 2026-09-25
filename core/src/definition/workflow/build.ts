import type { AgentBinding } from "../binding.js";
import type { BuildDiagnostic, JsonObject, JsonValue } from "../../types/shared.js";
import type {
  WorkflowBinding,
  WorkflowManifest,
  WorkflowNode,
  WorkflowNodeImplementation,
} from "../../types/workflow.js";
import type { ToolSchemaSource } from "../../types/tool.js";
import { canonical } from "../../utils/canonical.js";
import { diagnostic, fail } from "./diagnostics.js";
import type { BuiltWorkflow } from "./types.js";

export type BuildAccumulator = {
  readonly agents: Record<string, AgentBinding>;
  readonly nodes: Record<string, WorkflowNodeImplementation>;
  readonly sandboxSpecs: JsonObject[];
};

export function emptyAccumulator(): BuildAccumulator {
  return { agents: {}, nodes: {}, sandboxSpecs: [] };
}

export function mergeChild(
  acc: BuildAccumulator,
  child: {
    readonly agents: Record<string, AgentBinding>;
    readonly nodes: Record<string, WorkflowNodeImplementation>;
    readonly sandboxSpecs: readonly JsonObject[];
  },
): void {
  Object.assign(acc.agents, child.agents);
  Object.assign(acc.nodes, child.nodes);
  for (const spec of child.sandboxSpecs) acc.sandboxSpecs.push(spec);
}

/**
 * Every agent in the tree that declares a sandbox must declare an identical spec
 * (workflows.md §8). Returns the common spec, or undefined when none declare one.
 */
export function resolveWorkflowSandbox(
  specs: readonly JsonObject[],
): { sandbox?: JsonObject; diagnostics: BuildDiagnostic[] } {
  if (specs.length === 0) return { diagnostics: [] };
  const keys = new Set(specs.map((s) => canonical(s)));
  if (keys.size > 1)
    return {
      diagnostics: [
        diagnostic(
          "workflow.sandbox-mismatch",
          "Every agent in the tree that declares a sandbox must declare an identical spec",
        ),
      ],
    };
  return { sandbox: specs[0], diagnostics: [] };
}

export type FinishOptions<In = JsonValue, Out = JsonValue> = {
  readonly id: string;
  readonly root: WorkflowNode;
  readonly acc: BuildAccumulator;
  readonly inputSchema?: ToolSchemaSource;
  readonly outputSchema?: ToolSchemaSource;
  /** Extra diagnostics collected by the primitive. */
  readonly diagnostics?: readonly BuildDiagnostic[];
};

/**
 * Assemble a BuiltWorkflow: non-enumerable getBinding, manifest-only toJSON,
 * optional document-level sandbox (workflows.md §18).
 */
export function finishWorkflow<In = JsonValue, Out = JsonValue>(
  options: FinishOptions<In, Out>,
): BuiltWorkflow<In, Out> {
  const diagnostics = [...(options.diagnostics ?? [])];
  const { sandbox, diagnostics: sandboxDiagnostics } = resolveWorkflowSandbox(
    options.acc.sandboxSpecs,
  );
  diagnostics.push(...sandboxDiagnostics);
  if (diagnostics.length) fail(diagnostics);

  const manifest: WorkflowManifest = {
    kind: "workflow",
    workflowSchemaVersion: 1,
    id: options.id,
    root: options.root,
    ...(sandbox === undefined ? {} : { sandbox: sandbox as WorkflowManifest["sandbox"] }),
  };

  const binding: WorkflowBinding = Object.freeze({
    manifest,
    nodes: Object.freeze({ ...options.acc.nodes }),
    agents: Object.freeze({ ...options.acc.agents }),
  });

  const built = {
    id: options.id,
    manifest,
    toJSON: () => manifest,
    ...(options.inputSchema === undefined ? {} : { inputSchema: options.inputSchema }),
    ...(options.outputSchema === undefined ? {} : { outputSchema: options.outputSchema }),
  } as BuiltWorkflow<In, Out>;

  Object.defineProperty(built, "getBinding", {
    value: () => binding,
    enumerable: false,
  });

  return built;
}
