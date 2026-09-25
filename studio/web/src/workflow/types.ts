/** Wire shapes for workflow manifests and seam events (studio-local; no core package import). */

export type WorkflowFnRef = { readonly fn: true };
export type WorkflowAgentNode = { readonly agent: string };
export type WorkflowToolNode = {
  readonly tool: {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema?: unknown;
    readonly outputSchema?: unknown;
  };
};
export type WorkflowChainNode = {
  readonly chain: { readonly id: string; readonly steps: readonly WorkflowNode[] };
};
export type WorkflowSwitchNode = {
  readonly switch: {
    readonly id: string;
    readonly on: WorkflowFnRef;
    readonly cases: Readonly<Record<string, WorkflowNode>>;
    readonly default?: WorkflowNode;
  };
};
export type WorkflowParallelNode = {
  readonly parallel: {
    readonly id: string;
    readonly branches: Readonly<Record<string, WorkflowNode>>;
  };
};
export type WorkflowMapNode = {
  readonly map: {
    readonly id: string;
    readonly over: WorkflowFnRef;
    readonly each: WorkflowNode;
  };
};
export type WorkflowLoopNode = {
  readonly loop: {
    readonly id: string;
    readonly run: WorkflowNode;
    readonly verify: WorkflowFnRef | WorkflowAgentNode | WorkflowSlotNode;
    readonly decide: WorkflowFnRef;
  };
};
export type WorkflowSlotNode = {
  readonly slot: {
    readonly id?: string;
    readonly input?: WorkflowFnRef;
    readonly run: WorkflowNode;
  };
};
export type WorkflowNode =
  | WorkflowAgentNode
  | WorkflowToolNode
  | WorkflowChainNode
  | WorkflowSwitchNode
  | WorkflowParallelNode
  | WorkflowMapNode
  | WorkflowLoopNode
  | WorkflowSlotNode;

export type WorkflowManifest = {
  readonly kind: "workflow";
  readonly workflowSchemaVersion: 1;
  readonly id: string;
  readonly root: WorkflowNode;
  readonly sandbox?: unknown;
};

/** How Studio lays out a control node (workflows.md §11). */
export type TreeLayout = "row" | "fork" | "lanes" | "map" | "loop" | "leaf" | "slot";

export type TreeNodeKind =
  | "agent"
  | "tool"
  | "chain"
  | "switch"
  | "parallel"
  | "map"
  | "loop"
  | "slot"
  | "case"
  | "branch"
  | "item"
  | "fn";

export type WorkflowTreeNode = {
  readonly path: string;
  readonly key: string;
  readonly kind: TreeNodeKind;
  readonly layout: TreeLayout;
  readonly label: string;
  /** Agent definition id when kind is agent. */
  readonly agentId?: string;
  readonly children: readonly WorkflowTreeNode[];
};

export type NodeRunStatus =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "waiting"
  | "selected";

export type NodeLiveState = {
  readonly status: NodeRunStatus;
  readonly iterations?: string;
  readonly iteration?: number;
  readonly mapCount?: number;
  readonly selectedCase?: string;
  readonly agentSessionId?: string;
  readonly agentTurnId?: string;
  readonly error?: { readonly code: string; readonly message: string };
};

/** agentSessionId → workflow ownership (Runtime links index shape). */
export type WorkflowLink = {
  readonly workflowSessionId: string;
  readonly path: string;
  readonly workflowAgentId?: string;
};

export type AgentManifestLike = {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly capabilities?: readonly {
    readonly id: string;
    readonly instructions?: string;
    readonly tools?: readonly { readonly name: string }[];
    readonly hooks?: readonly unknown[];
  }[];
  readonly model?: string;
};

export type IterationRecord = {
  readonly n: number;
  readonly path: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly manifestHash?: string;
  readonly waiting?: boolean;
  readonly pass?: boolean;
  readonly feedback?: string;
  readonly decided?: "input" | "output";
  readonly patched?: boolean;
  /** Human summary of decide patch vs previous iteration (LOOP-EV5). */
  readonly patchSummary?: string;
};

export type EventLike = {
  readonly type: string;
  readonly payload?: unknown;
  readonly sessionId?: string;
};

export function isWorkflowManifest(value: unknown): value is WorkflowManifest {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "workflow" &&
    typeof (value as { id?: unknown }).id === "string" &&
    (value as { root?: unknown }).root !== undefined
  );
}

export function joinPath(parent: string, part: string): string {
  return parent ? `${parent}/${part}` : part;
}

export function nodeKeyOf(path: string): string {
  return path.replace(/\[\d+]/g, "");
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

export function payloadOf(event: EventLike): Readonly<Record<string, unknown>> {
  return record(event.payload);
}
