import { createHash } from "node:crypto";
import type { Action, ActionOutcome, LiveEvent } from "@nylorun/core/contracts";
import type { JsonValue, WorkflowManifest } from "@nylorun/core/define";
import type { EffectResolution, HostEffect } from "@nylorun/harness/run";
import {
  mayDispatchMore,
  type FlowLimits,
} from "./limits.js";

/** Deterministic agent session id: derive(workflowSessionId, path, …parts). */
export function deriveSessionId(
  workflowSessionId: string,
  path: string,
  ...parts: string[]
): string {
  const digest = createHash("sha256")
    .update([workflowSessionId, path, ...parts].join("\0"))
    .digest("hex")
    .slice(0, 24);
  return `wf_${digest}`;
}

export function isWorkflowManifest(
  manifest: unknown
): manifest is WorkflowManifest {
  return (
    !!manifest &&
    typeof manifest === "object" &&
    (manifest as { kind?: unknown }).kind === "workflow"
  );
}

/** Flow tool-node effect: `tool` with path/key and no agent capabilityId. */
export function isFlowToolEffect(request: HostEffect): boolean {
  return (
    request.kind === "tool" &&
    typeof request.path === "string" &&
    request.path.length > 0 &&
    typeof request.key === "string" &&
    request.key.length > 0 &&
    request.capabilityId === undefined
  );
}

export function isFlowEffect(request: HostEffect): boolean {
  return (
    request.kind === "agent" ||
    request.kind === "fn" ||
    request.kind === "verify" ||
    isFlowToolEffect(request)
  );
}

export type FlowLink = {
  readonly workflowSessionId: string;
  readonly path: string;
  readonly effectId: string;
  readonly turnId: string;
};

export type FlowHostStore = {
  get<T = any>(table: string, id: string): T | undefined;
  put(table: string, id: string, body: unknown): void;
  all<T = any>(table: string): T[];
  event(
    sessionId: string,
    turnId: string | null,
    type: string,
    payload: unknown
  ): LiveEvent;
};

export type FlowHostSession = {
  id: string;
  agentId: string;
  ownerUserId: string;
  manifest: any;
  manifestHash: string;
  implementationVersion: string;
  status: string;
  activeTurnId: string | null;
  info?: any;
  vaultIds?: readonly string[];
  credentialSelections?: readonly unknown[];
  creation?: unknown;
  waits?: unknown;
  lastOutput?: JsonValue;
  error?: string;
};

export type FlowWait = {
  readonly sessionId: string;
  readonly path: string;
  readonly interactionId: string;
  readonly kind: string;
  readonly invocationId?: string;
  readonly wait?: unknown;
  readonly status?: string;
};

export type CancelSiblingResult = {
  readonly cancelledActions: string[];
  readonly uncertainActions: string[];
  readonly agentSessionIds: string[];
};

export type CascadeCancelPlan = {
  /** Linked agent sessions to cancel, deepest path first. */
  readonly agentSessionIds: string[];
  readonly pendingActionIds: string[];
  readonly claimedActionIds: string[];
};

/**
 * Resolve flow effects: agent (via session contract), tool nodes, fn, verify.
 * Runtime never writes agent session state — only issues commands.
 */
export function resolveFlowEffect(input: {
  readonly request: HostEffect;
  readonly store: FlowHostStore;
  readonly session: FlowHostSession;
  readonly limits?: FlowLimits;
  readonly putLinkedSession: (args: {
    id: string;
    agentId: string;
    ownerUserId: string;
    vaultIds?: readonly string[];
    credentialSelections?: readonly unknown[];
  }) => FlowHostSession;
  readonly sendMessage: (args: {
    sessionId: string;
    content?: string;
    data?: JsonValue;
    idempotencyKey: string;
    requestId: string;
  }) => { turnId: string | null };
  readonly readSession: (id: string) => FlowHostSession | undefined;
  readonly publish: (event: LiveEvent) => void;
  readonly notify: () => void;
  readonly schedule: (sessionId: string) => void;
}): EffectResolution {
  const { request, store, session } = input;
  if (!isFlowEffect(request))
    throw new Error(`Not a flow effect: ${request.kind}`);

  const existing = store.get("effects", request.effectId);
  if (existing) {
    if (existing.status === "completed")
      return { status: "completed", outcome: existing.outcome };
    if (existing.status === "queued") {
      if (
        input.limits &&
        !mayDispatchMore(
          countActiveFlowWork(store, session.id, request.turnId),
          input.limits
        )
      )
        return { status: "pending" };
      return dispatchQueuedEffect(input, existing);
    }
    if (request.kind === "agent")
      return settleAgentEffect(input, existing) ?? { status: "pending" };
    return {
      status:
        existing.status === "uncertain" || existing.status === "invoking"
          ? "uncertain"
          : "pending",
    };
  }

  if (
    input.limits &&
    !mayDispatchMore(
      countActiveFlowWork(store, session.id, request.turnId),
      input.limits
    )
  ) {
    store.put("effects", request.effectId, {
      request,
      status: "queued",
    });
    return { status: "pending" };
  }

  if (request.kind === "agent") return startAgentEffect(input);
  if (isFlowToolEffect(request)) return startToolNode(input);
  return startFnOrVerify(input);
}

/** Active agent turns + pending/claimed actions for one workflow turn. */
export function countActiveFlowWork(
  store: FlowHostStore,
  workflowSessionId: string,
  turnId: string
): number {
  let n = 0;
  for (const effect of store.all("effects")) {
    if (effect.request?.sessionId !== workflowSessionId) continue;
    if (effect.request?.turnId !== turnId) continue;
    if (effect.status === "queued") continue;
    if (effect.status === "completed" || effect.status === "cancelled")
      continue;
    if (effect.request?.kind === "agent" && effect.status === "pending") {
      n += 1;
      continue;
    }
    if (
      effect.request?.kind === "fn" ||
      effect.request?.kind === "verify" ||
      isFlowToolEffect(effect.request)
    ) {
      const action = store.get<Action>("actions", effect.request.effectId);
      if (
        action &&
        (action.status === "pending" || action.status === "claimed")
      )
        n += 1;
    }
  }
  return n;
}

function dispatchQueuedEffect(
  input: Parameters<typeof resolveFlowEffect>[0],
  existing: { request: HostEffect; status: string }
): EffectResolution {
  const { request, store } = input;
  store.put("effects", request.effectId, {
    ...existing,
    status: "pending",
  });
  if (request.kind === "agent") return startAgentEffect(input);
  if (isFlowToolEffect(request)) return startToolNode(input);
  return startFnOrVerify(input);
}

function startFnOrVerify(input: {
  readonly request: HostEffect;
  readonly store: FlowHostStore;
  readonly session: FlowHostSession;
  readonly publish: (event: LiveEvent) => void;
  readonly notify: () => void;
}): EffectResolution {
  const { request, store, session } = input;
  store.put("effects", request.effectId, {
    request,
    status: "pending",
  });
  const kind = request.kind as "fn" | "verify";
  const action = {
    actionId: request.effectId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    agentId: request.agentId,
    manifestHash: request.manifestHash,
    implementationVersion: session.implementationVersion,
    input: request.input,
    context: request.context,
    status: "pending" as const,
    generation: 0,
    claimId: null,
    leaseExpiresAt: null,
    kind,
    path: request.path!,
    key: request.key!,
  } satisfies Action;
  store.put("actions", action.actionId, action);
  const event = store.event(
    session.id,
    session.activeTurnId,
    "action.pending",
    {
      actionId: action.actionId,
      kind: action.kind,
      path: action.path,
      key: action.key,
      input: action.input,
    }
  );
  input.publish(event);
  input.notify();
  return { status: "pending" };
}

function startToolNode(input: {
  readonly request: HostEffect;
  readonly store: FlowHostStore;
  readonly session: FlowHostSession;
  readonly publish: (event: LiveEvent) => void;
  readonly notify: () => void;
}): EffectResolution {
  const { request, store, session } = input;
  store.put("effects", request.effectId, {
    request,
    status: "pending",
  });
  const action = {
    actionId: request.effectId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    agentId: request.agentId,
    manifestHash: request.manifestHash,
    implementationVersion: session.implementationVersion,
    input: request.input,
    context: request.context,
    status: "pending" as const,
    generation: 0,
    claimId: null,
    leaseExpiresAt: null,
    kind: "tool" as const,
    path: request.path!,
    key: request.key!,
  } satisfies Action;
  store.put("actions", action.actionId, action);
  emitNodeStarted(input, {
    path: request.path!,
    kind: "tool",
    key: request.key!,
    iterations: request.iterations,
  });
  const event = store.event(
    session.id,
    session.activeTurnId,
    "action.pending",
    {
      actionId: action.actionId,
      kind: action.kind,
      path: action.path,
      key: action.key,
      input: action.input,
    }
  );
  input.publish(event);
  input.notify();
  return { status: "pending" };
}

function startAgentEffect(input: {
  readonly request: HostEffect;
  readonly store: FlowHostStore;
  readonly session: FlowHostSession;
  readonly putLinkedSession: (args: {
    id: string;
    agentId: string;
    ownerUserId: string;
    vaultIds?: readonly string[];
    credentialSelections?: readonly unknown[];
  }) => FlowHostSession;
  readonly sendMessage: (args: {
    sessionId: string;
    content?: string;
    data?: JsonValue;
    idempotencyKey: string;
    requestId: string;
  }) => { turnId: string | null };
  readonly readSession: (id: string) => FlowHostSession | undefined;
  readonly publish: (event: LiveEvent) => void;
  readonly notify: () => void;
  readonly schedule: (sessionId: string) => void;
}): EffectResolution {
  const { request, store, session } = input;
  const body = request.input as {
    agentId: string;
    input: JsonValue;
    path: string;
  };
  const path = body.path ?? request.path!;
  const agentSessionId = deriveSessionId(session.id, path);
  const iterations = request.iterations ?? "-";
  const n = Number(request.context.n ?? iterations.split(".")[0] ?? 1);

  store.put("effects", request.effectId, {
    request,
    status: "pending",
    agentSessionId,
  });
  store.put("links", agentSessionId, {
    workflowSessionId: session.id,
    path,
    effectId: request.effectId,
    turnId: request.turnId,
  } satisfies FlowLink);

  const existingAgent = input.readSession(agentSessionId);
  if (!existingAgent) {
    input.putLinkedSession({
      id: agentSessionId,
      agentId: body.agentId,
      ownerUserId: session.ownerUserId,
      vaultIds: session.vaultIds,
      credentialSelections: session.credentialSelections,
    });
  }

  const idempotencyKey = `${request.turnId}:${path}:${iterations}`;
  const messageInput = body.input;
  const accepted = input.sendMessage({
    sessionId: agentSessionId,
    ...(typeof messageInput === "string"
      ? { content: messageInput }
      : { data: messageInput }),
    idempotencyKey,
    requestId: `flow-${request.effectId}`,
  });

  const iterationEvent = store.event(
    session.id,
    session.activeTurnId,
    "loop.iteration",
    {
      path: String(request.context.loopPath ?? path.split("/")[0]),
      n,
      sessionId: agentSessionId,
      turnId: accepted.turnId ?? undefined,
    }
  );
  input.publish(iterationEvent);

  const nodeAgent = store.event(
    session.id,
    session.activeTurnId,
    "node.agent",
    {
      path,
      iterations,
      sessionId: agentSessionId,
      turnId: accepted.turnId,
    }
  );
  input.publish(nodeAgent);

  return (
    settleAgentEffect(input, store.get("effects", request.effectId)!) ?? {
      status: "pending",
    }
  );
}

function settleAgentEffect(
  input: {
    readonly request: HostEffect;
    readonly store: FlowHostStore;
    readonly session: FlowHostSession;
    readonly readSession: (id: string) => FlowHostSession | undefined;
    readonly publish: (event: LiveEvent) => void;
  },
  effect: {
    status: string;
    outcome?: ActionOutcome;
    agentSessionId?: string;
  }
): EffectResolution | undefined {
  if (effect.status === "completed" && effect.outcome)
    return { status: "completed", outcome: effect.outcome };

  const agentSessionId =
    effect.agentSessionId ??
    deriveSessionId(
      input.session.id,
      (input.request.input as { path?: string }).path ?? input.request.path!
    );
  const agent = input.readSession(agentSessionId);
  if (!agent) return undefined;

  if (agent.status === "completed" && agent.activeTurnId === null) {
    const output = agent.lastOutput ?? null;
    const outcome: ActionOutcome = { value: output };
    input.store.put("effects", input.request.effectId, {
      request: input.request,
      status: "completed",
      outcome,
      agentSessionId,
    });
    return { status: "completed", outcome };
  }

  if (agent.status === "failed") {
    const outcome: ActionOutcome = {
      value: {
        kind: "failed",
        code: "agent.failed",
        message: agent.error ?? "Agent turn failed",
      },
    };
    input.store.put("effects", input.request.effectId, {
      request: input.request,
      status: "completed",
      outcome,
      agentSessionId,
    });
    return { status: "completed", outcome };
  }

  if (agent.status === "cancelled") {
    const outcome: ActionOutcome = {
      value: {
        kind: "failed",
        code: "agent.cancelled",
        message: agent.error ?? "Agent turn was cancelled",
      },
    };
    input.store.put("effects", input.request.effectId, {
      request: input.request,
      status: "completed",
      outcome,
      agentSessionId,
    });
    return { status: "completed", outcome };
  }

  return undefined;
}

/** After an agent turn settles, wake the owning workflow if linked. */
export function wakeLinkedWorkflow(input: {
  readonly agentSessionId: string;
  readonly store: FlowHostStore;
  readonly output?: JsonValue;
  readonly failed?: boolean;
  readonly cancelled?: boolean;
  readonly error?: string;
  readonly schedule: (sessionId: string) => void;
  readonly publish: (event: LiveEvent) => void;
}): void {
  const link = input.store.get<FlowLink>("links", input.agentSessionId);
  if (!link) return;
  const effect = input.store.get("effects", link.effectId);
  if (!effect || effect.status === "completed") return;

  const workflow = input.store.get<FlowHostSession>(
    "sessions",
    link.workflowSessionId
  );
  if (!workflow) return;
  if (workflow.activeTurnId !== link.turnId) return;

  const outcome: ActionOutcome = input.cancelled
    ? {
        value: {
          kind: "failed",
          code: "agent.cancelled",
          message: input.error ?? "Agent turn was cancelled",
        },
      }
    : input.failed
      ? {
          value: {
            kind: "failed",
            code: "agent.failed",
            message: input.error ?? "Agent turn failed",
          },
        }
      : { value: input.output ?? null };

  input.store.put("effects", link.effectId, {
    ...effect,
    status: "completed",
    outcome,
  });

  workflow.status = "runnable";
  input.store.put("sessions", workflow.id, workflow);
  input.schedule(workflow.id);
}

/** On Runtime start: settle pending agent effects whose linked turns already finished. */
export function reconcilePendingAgentEffects(input: {
  readonly store: FlowHostStore;
  readonly schedule: (sessionId: string) => void;
  readonly publish: (event: LiveEvent) => void;
}): void {
  for (const effect of input.store.all("effects")) {
    if (effect.request?.kind !== "agent" || effect.status !== "pending")
      continue;
    const id =
      typeof effect.agentSessionId === "string"
        ? effect.agentSessionId
        : undefined;
    if (!id) continue;
    const agent = input.store.get<FlowHostSession>("sessions", id);
    const workflow = input.store.get<FlowHostSession>(
      "sessions",
      effect.request.sessionId
    );
    if (workflow && workflow.status === "waiting") {
      workflow.status = "runnable";
      input.store.put("sessions", workflow.id, workflow);
      input.schedule(workflow.id);
    }
    if (!agent) continue;
    if (agent.status === "completed") {
      wakeLinkedWorkflow({
        agentSessionId: id,
        store: input.store,
        output: agent.lastOutput ?? null,
        schedule: input.schedule,
        publish: input.publish,
      });
    } else if (agent.status === "failed") {
      wakeLinkedWorkflow({
        agentSessionId: id,
        store: input.store,
        failed: true,
        error: agent.error,
        schedule: input.schedule,
        publish: input.publish,
      });
    } else if (agent.status === "cancelled") {
      wakeLinkedWorkflow({
        agentSessionId: id,
        store: input.store,
        cancelled: true,
        error: agent.error,
        schedule: input.schedule,
        publish: input.publish,
      });
    } else if (agent.status === "running" || agent.status === "runnable") {
      input.schedule(id);
    } else if (agent.status === "paused") {
      // Linked pause surfaces on the workflow waits list; keep waiting.
      if (workflow && workflow.status !== "paused") {
        const waits = aggregateWaits({
          store: input.store,
          workflowSessionId: workflow.id,
        });
        if (waits.length > 0) {
          workflow.status = "paused";
          workflow.waits = waits;
          input.store.put("sessions", workflow.id, workflow);
        }
      }
    }
  }
}

/** Re-offer orphaned fn/verify claims after a process restart (SD-P7 / WF-C9). */
export function reofferOrphanedFnVerifyClaims(store: FlowHostStore): number {
  let n = 0;
  for (const action of store.all<Action>("actions")) {
    if (
      action.status === "claimed" &&
      (action.kind === "fn" || action.kind === "verify")
    ) {
      action.status = "pending";
      (action as { claimId: null }).claimId = null;
      (action as { leaseExpiresAt: null }).leaseExpiresAt = null;
      store.put("actions", action.actionId, action);
      const s = store.get<FlowHostSession>("sessions", action.sessionId);
      if (s && (s.status === "waiting" || s.status === "running")) {
        s.status = "runnable";
        store.put("sessions", s.id, s);
      }
      n += 1;
    }
  }
  return n;
}

/**
 * On lease expiry: fn/verify → pending again; tool nodes → uncertain (WF-R35, WF-R38).
 * Returns whether any fn/verify was redelivered.
 */
export function applyFlowLeaseExpiry(input: {
  readonly store: FlowHostStore;
  readonly action: Action;
  readonly now?: number;
}): "reoffer" | "uncertain" | "skip" {
  if (input.action.status !== "claimed" || !input.action.leaseExpiresAt)
    return "skip";
  const now = input.now ?? Date.now();
  if (Date.parse(input.action.leaseExpiresAt) > now) return "skip";

  if (input.action.kind === "fn" || input.action.kind === "verify") {
    input.action.status = "pending";
    (input.action as { claimId: null }).claimId = null;
    (input.action as { leaseExpiresAt: null }).leaseExpiresAt = null;
    input.store.put("actions", input.action.actionId, input.action);
    return "reoffer";
  }

  if (
    input.action.kind === "tool" &&
    "path" in input.action &&
    !("capabilityId" in input.action)
  ) {
    input.action.status = "uncertain";
    input.store.put("actions", input.action.actionId, input.action);
    const effect = input.store.get("effects", input.action.actionId);
    if (effect) {
      effect.status = "uncertain";
      input.store.put("effects", input.action.actionId, effect);
    }
    return "uncertain";
  }

  return "skip";
}

/** Emit loop.verified / loop.decided after fn/verify actions complete. */
export function emitLoopActionEvents(input: {
  readonly store: FlowHostStore;
  readonly session: FlowHostSession;
  readonly action: Action;
  readonly value: unknown;
  readonly publish: (event: LiveEvent) => void;
}): void {
  const { action, store, session } = input;
  if (action.kind !== "fn" && action.kind !== "verify") return;
  const n = Number(action.context?.n ?? 1);
  const path = String(action.context?.loopPath ?? action.path ?? "");
  if (action.kind === "verify") {
    const verdict = input.value as {
      pass?: boolean;
      feedback?: string;
      data?: JsonValue;
      kind?: string;
    };
    if (verdict?.kind === "failed") return;
    const event = store.event(
      session.id,
      session.activeTurnId,
      "loop.verified",
      {
        path,
        n,
        pass: Boolean(verdict?.pass),
        ...(verdict?.feedback !== undefined
          ? { feedback: verdict.feedback }
          : {}),
        ...(verdict?.data !== undefined ? { data: verdict.data } : {}),
      }
    );
    input.publish(event);
    return;
  }
  if (action.context?.role !== "decide") return;
  const decision = input.value as {
    input?: unknown;
    output?: unknown;
    agent?: unknown;
  };
  const event = store.event(session.id, session.activeTurnId, "loop.decided", {
    path,
    n,
    next: "output" in decision && !("input" in decision) ? "output" : "input",
    patched: Boolean(decision.agent),
  });
  input.publish(event);
}

export function emitNodeStarted(
  input: {
    readonly store: FlowHostStore;
    readonly session: FlowHostSession;
    readonly publish: (event: LiveEvent) => void;
  },
  payload: {
    path: string;
    kind: string;
    key: string;
    iterations?: string;
  }
): LiveEvent {
  const event = input.store.event(
    input.session.id,
    input.session.activeTurnId,
    "node.started",
    payload
  );
  input.publish(event);
  return event;
}

export function emitNodeCompleted(
  input: {
    readonly store: FlowHostStore;
    readonly session: FlowHostSession;
    readonly publish: (event: LiveEvent) => void;
  },
  payload: { path: string; iterations?: string }
): LiveEvent {
  const event = input.store.event(
    input.session.id,
    input.session.activeTurnId,
    "node.completed",
    payload
  );
  input.publish(event);
  return event;
}

export function emitNodeFailed(
  input: {
    readonly store: FlowHostStore;
    readonly session: FlowHostSession;
    readonly publish: (event: LiveEvent) => void;
  },
  payload: {
    path: string;
    iterations?: string;
    error: { code: string; message: string; path?: string };
  }
): LiveEvent {
  const event = input.store.event(
    input.session.id,
    input.session.activeTurnId,
    "node.failed",
    payload
  );
  input.publish(event);
  return event;
}

export function emitSwitchSelected(
  input: {
    readonly store: FlowHostStore;
    readonly session: FlowHostSession;
    readonly publish: (event: LiveEvent) => void;
  },
  payload: { path: string; case: string }
): LiveEvent {
  const event = input.store.event(
    input.session.id,
    input.session.activeTurnId,
    "switch.selected",
    payload
  );
  input.publish(event);
  return event;
}

export function emitMapItems(
  input: {
    readonly store: FlowHostStore;
    readonly session: FlowHostSession;
    readonly publish: (event: LiveEvent) => void;
  },
  payload: { path: string; count: number }
): LiveEvent {
  const event = input.store.event(
    input.session.id,
    input.session.activeTurnId,
    "map.items",
    payload
  );
  input.publish(event);
  return event;
}

/** Path depth for deepest-first cancel ordering. */
export function pathDepth(path: string): number {
  if (!path) return 0;
  return path.split("/").filter(Boolean).length;
}

/**
 * Plan a cancel cascade for a workflow session: linked agents deepest first,
 * then pending → cancelled and claimed → uncertain actions (SD-P11 / WF-R53).
 */
export function planCancelCascade(input: {
  readonly store: FlowHostStore;
  readonly workflowSessionId: string;
  readonly turnId: string | null;
}): CascadeCancelPlan {
  // links table is keyed by agentSessionId — discover via sessions + get(links, id).
  const agentEntries: { sessionId: string; path: string }[] = [];
  for (const sess of input.store.all<FlowHostSession>("sessions")) {
    const link = input.store.get<FlowLink>("links", sess.id);
    if (!link || link.workflowSessionId !== input.workflowSessionId) continue;
    agentEntries.push({ sessionId: sess.id, path: link.path });
  }
  agentEntries.sort((a, b) => pathDepth(b.path) - pathDepth(a.path));

  const pendingActionIds: string[] = [];
  const claimedActionIds: string[] = [];
  for (const action of input.store.all<Action>("actions")) {
    if (action.sessionId !== input.workflowSessionId) continue;
    if (input.turnId !== null && action.turnId !== input.turnId) continue;
    if (action.status === "pending") pendingActionIds.push(action.actionId);
    else if (action.status === "claimed")
      claimedActionIds.push(action.actionId);
  }

  return {
    agentSessionIds: agentEntries.map((e) => e.sessionId),
    pendingActionIds,
    claimedActionIds,
  };
}

/**
 * Cancel sibling work under a Parallel/Map parent when one branch fails (PAR-R6).
 * Agent turns listed in `agentSessionIds` are returned for the caller to cancel;
 * pending actions → cancelled, claimed tool actions → uncertain.
 */
export function cancelSiblingWork(input: {
  readonly store: FlowHostStore;
  readonly workflowSessionId: string;
  readonly turnId: string;
  /** Paths of siblings still running (not the failed branch). */
  readonly siblingPaths: readonly string[];
}): CancelSiblingResult {
  const cancelledActions: string[] = [];
  const uncertainActions: string[] = [];
  const agentSessionIds: string[] = [];

  const matchesSibling = (path: string | undefined): boolean => {
    if (!path) return false;
    return input.siblingPaths.some(
      (sib) => path === sib || path.startsWith(`${sib}/`)
    );
  };

  for (const sess of input.store.all<FlowHostSession>("sessions")) {
    const link = input.store.get<FlowLink>("links", sess.id);
    if (!link || link.workflowSessionId !== input.workflowSessionId) continue;
    if (!matchesSibling(link.path)) continue;
    if (
      sess.activeTurnId &&
      ["running", "runnable", "paused", "waiting"].includes(sess.status)
    )
      agentSessionIds.push(sess.id);
  }

  for (const action of input.store.all<Action>("actions")) {
    if (action.sessionId !== input.workflowSessionId) continue;
    if (action.turnId !== input.turnId) continue;
    if (!matchesSibling((action as { path?: string }).path)) continue;
    if (action.status === "pending") {
      action.status = "cancelled";
      input.store.put("actions", action.actionId, action);
      const effect = input.store.get("effects", action.actionId);
      if (effect) {
        effect.status = "cancelled";
        input.store.put("effects", action.actionId, effect);
      }
      cancelledActions.push(action.actionId);
    } else if (action.status === "claimed") {
      action.status = "uncertain";
      input.store.put("actions", action.actionId, action);
      const effect = input.store.get("effects", action.actionId);
      if (effect) {
        effect.status = "uncertain";
        input.store.put("effects", action.actionId, effect);
      }
      uncertainActions.push(action.actionId);
    }
  }

  return { cancelledActions, uncertainActions, agentSessionIds };
}

/**
 * Apply cancel fencing to workflow-session actions (pending→cancelled, claimed→uncertain).
 */
export function fenceWorkflowActions(input: {
  readonly store: FlowHostStore;
  readonly workflowSessionId: string;
  readonly turnId: string | null;
}): { cancelled: string[]; uncertain: string[] } {
  const cancelled: string[] = [];
  const uncertain: string[] = [];
  for (const action of input.store.all<Action>("actions")) {
    if (action.sessionId !== input.workflowSessionId) continue;
    if (input.turnId !== null && action.turnId !== input.turnId) continue;
    if (!["pending", "claimed"].includes(action.status)) continue;
    const next = action.status === "claimed" ? "uncertain" : "cancelled";
    action.status = next as Action["status"];
    input.store.put("actions", action.actionId, action);
    const effect = input.store.get("effects", action.actionId);
    if (effect) {
      effect.status = next;
      input.store.put("effects", action.actionId, effect);
    }
    if (next === "cancelled") cancelled.push(action.actionId);
    else uncertain.push(action.actionId);
  }
  // Drop queued effects that never started.
  for (const effect of input.store.all("effects")) {
    if (effect.request?.sessionId !== input.workflowSessionId) continue;
    if (input.turnId !== null && effect.request?.turnId !== input.turnId)
      continue;
    if (effect.status === "queued") {
      effect.status = "cancelled";
      input.store.put("effects", effect.request.effectId, effect);
      cancelled.push(effect.request.effectId);
    }
  }
  return { cancelled, uncertain };
}

/**
 * Aggregate human waits across the workflow session and linked agent sessions (WF-R51).
 */
export function aggregateWaits(input: {
  readonly store: FlowHostStore;
  readonly workflowSessionId: string;
}): FlowWait[] {
  const waits: FlowWait[] = [];
  const workflow = input.store.get<FlowHostSession>(
    "sessions",
    input.workflowSessionId
  );
  if (!workflow) return waits;

  const pushFromSession = (
    session: FlowHostSession,
    path: string,
    raw: unknown
  ) => {
    if (!Array.isArray(raw)) return;
    for (const call of raw as any[]) {
      const interaction = call.interaction ?? call;
      const interactionId = String(
        interaction?.id ?? call.interactionId ?? ""
      );
      if (!interactionId) continue;
      waits.push({
        sessionId: session.id,
        path,
        interactionId,
        kind: String(interaction?.kind ?? call.kind ?? "approval"),
        ...(call.invocationId !== undefined
          ? { invocationId: String(call.invocationId) }
          : {}),
        ...(call.wait !== undefined ? { wait: call.wait } : {}),
        ...(call.status !== undefined ? { status: String(call.status) } : {}),
      });
    }
  };

  // Workflow-owned interactions (tool-node / verify approvals) live on the workflow session.
  if (Array.isArray(workflow.waits))
    pushFromSession(workflow, "", workflow.waits);
  else if (
    workflow.waits &&
    typeof workflow.waits === "object" &&
    Array.isArray((workflow.waits as any).interactions)
  )
    pushFromSession(workflow, "", (workflow.waits as any).interactions);

  for (const sess of input.store.all<FlowHostSession>("sessions")) {
    const link = input.store.get<FlowLink>("links", sess.id);
    if (!link || link.workflowSessionId !== input.workflowSessionId) continue;
    if (sess.status !== "paused") continue;
    pushFromSession(sess, link.path, sess.waits);
  }

  return waits;
}

/**
 * Look up which session owns an interaction id. Used for 409 foreign approvals (WF-R52).
 */
export function findInteractionOwner(input: {
  readonly store: FlowHostStore;
  readonly workflowSessionId: string;
  readonly interactionId: string;
}): { sessionId: string; path: string } | undefined {
  const waits = aggregateWaits(input);
  const hit = waits.find((w) => w.interactionId === input.interactionId);
  if (hit) return { sessionId: hit.sessionId, path: hit.path };

  // Also scan linked paused sessions' plan-shaped waits that aggregateWaits may have missed.
  for (const sess of input.store.all<FlowHostSession>("sessions")) {
    const link = input.store.get<FlowLink>("links", sess.id);
    if (!link || link.workflowSessionId !== input.workflowSessionId) continue;
    const raw = sess.waits;
    if (!Array.isArray(raw)) continue;
    for (const call of raw as any[]) {
      const id = String(call.interaction?.id ?? call.interactionId ?? "");
      if (id === input.interactionId)
        return { sessionId: sess.id, path: link.path };
    }
  }
  return undefined;
}

/**
 * If approve/respond targets an interaction owned by a linked agent session,
 * return a 409 message naming that session (WF-R52 / LOOP-A4).
 */
export function foreignInteractionConflict(input: {
  readonly store: FlowHostStore;
  readonly workflowSessionId: string;
  readonly interactionId: string;
}): { status: 409; message: string; ownerSessionId: string } | undefined {
  const owner = findInteractionOwner(input);
  if (!owner) return undefined;
  if (owner.sessionId === input.workflowSessionId) return undefined;
  return {
    status: 409,
    message: `Interaction belongs to session ${owner.sessionId}`,
    ownerSessionId: owner.sessionId,
  };
}

/**
 * When concurrency slots free, re-enter the workflow so queued effects can start
 * (status stays `queued` until `resolveFlowEffect` dispatches them).
 */
export function wakeForQueuedEffects(input: {
  readonly store: FlowHostStore;
  readonly workflowSessionId: string;
  readonly turnId: string;
  readonly limits: FlowLimits;
  readonly schedule: (sessionId: string) => void;
}): boolean {
  if (
    !mayDispatchMore(
      countActiveFlowWork(
        input.store,
        input.workflowSessionId,
        input.turnId
      ),
      input.limits
    )
  )
    return false;
  const hasQueued = input.store
    .all("effects")
    .some(
      (e) =>
        e.status === "queued" &&
        e.request?.sessionId === input.workflowSessionId &&
        e.request?.turnId === input.turnId
    );
  if (!hasQueued) return false;
  const workflow = input.store.get<FlowHostSession>(
    "sessions",
    input.workflowSessionId
  );
  if (workflow && workflow.status === "waiting") {
    workflow.status = "runnable";
    input.store.put("sessions", workflow.id, workflow);
  }
  input.schedule(input.workflowSessionId);
  return true;
}
