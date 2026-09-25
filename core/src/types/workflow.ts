import type { AgentBinding } from "../definition/binding.js";
import type { BoundToolDefinition } from "../definition/bound.js";
import type { JsonObject, JsonValue } from "./shared.js";
import type { SandboxManifest } from "./manifest.js";

/** Loop verify outcome: pass, or fail with required feedback. */
export type Verdict =
  | { readonly pass: true; readonly data?: JsonValue }
  | { readonly pass: false; readonly feedback: string; readonly data?: JsonValue };

/** Local function marker in a workflow manifest (code never crosses the wire). */
export interface WorkflowFnRef {
  readonly fn: true;
}

/** Agent leaf: referenced by definition id. */
export interface WorkflowAgentNode {
  readonly agent: string;
}

/** Tool leaf: name and schemas only; implementation stays in the binding. */
export interface WorkflowToolNode {
  readonly tool: {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: JsonObject;
    readonly outputSchema?: JsonObject;
  };
}

export interface WorkflowChainNode {
  readonly chain: {
    readonly id: string;
    readonly steps: readonly WorkflowNode[];
  };
}

export interface WorkflowSwitchNode {
  readonly switch: {
    readonly id: string;
    readonly on: WorkflowFnRef;
    readonly cases: Readonly<Record<string, WorkflowNode>>;
    readonly default?: WorkflowNode;
  };
}

export interface WorkflowParallelNode {
  readonly parallel: {
    readonly id: string;
    readonly branches: Readonly<Record<string, WorkflowNode>>;
  };
}

export interface WorkflowMapNode {
  readonly map: {
    readonly id: string;
    readonly over: WorkflowFnRef;
    readonly each: WorkflowNode;
  };
}

export interface WorkflowLoopNode {
  readonly loop: {
    readonly id: string;
    readonly run: WorkflowNode;
    readonly verify: WorkflowFnRef | WorkflowAgentNode | WorkflowSlotNode;
    readonly decide: WorkflowFnRef;
  };
}

/** Rename and/or reshape a child: `{ slot: { id?, input?, run } }`. */
export interface WorkflowSlotNode {
  readonly slot: {
    readonly id?: string;
    readonly input?: WorkflowFnRef;
    readonly run: WorkflowNode;
  };
}

export type WorkflowNode =
  | WorkflowAgentNode
  | WorkflowToolNode
  | WorkflowChainNode
  | WorkflowSwitchNode
  | WorkflowParallelNode
  | WorkflowMapNode
  | WorkflowLoopNode
  | WorkflowSlotNode;

/** Wire document for a workflow definition. Missing `kind` is never a workflow. */
export interface WorkflowManifest {
  readonly kind: "workflow";
  readonly workflowSchemaVersion: 1;
  readonly id: string;
  readonly root: WorkflowNode;
  readonly sandbox?: SandboxManifest;
}

/**
 * Local implementation for a node key: a tool node, a pure `fn`, or a Loop `verify` function.
 * Functions are never serialized.
 */
export type WorkflowNodeImplementation =
  | { readonly kind: "tool"; readonly tool: BoundToolDefinition }
  | { readonly kind: "fn"; readonly fn: (...args: never[]) => unknown }
  | { readonly kind: "verify"; readonly fn: (...args: never[]) => unknown };

/**
 * Built-workflow binding: manifest plus node-key → implementation, and referenced agent bindings.
 * Not a wire format; `toJSON()` stays manifest-only.
 */
export interface WorkflowBinding {
  readonly manifest: WorkflowManifest;
  /** Node key (path without Map indices) → local code. */
  readonly nodes: Readonly<Record<string, WorkflowNodeImplementation>>;
  readonly agents: Readonly<Record<string, AgentBinding>>;
}
