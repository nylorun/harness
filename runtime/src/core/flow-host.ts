import { createHash } from "node:crypto";
import type { Action, ActionOutcome, LiveEvent } from "@nylorun/core/contracts";
import type { JsonValue, WorkflowManifest } from "@nylorun/core/define";
import type { EffectResolution, HostEffect } from "@nylorun/harness/run";

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
};

/**
 * Resolve flow effects: agent (via session contract), fn, verify.
 * Runtime never writes agent session state — only issues commands.
 */
export function resolveFlowEffect(input: {
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
  if (
    request.kind !== "agent" &&
    request.kind !== "fn" &&
    request.kind !== "verify"
  )
    throw new Error(`Not a flow effect: ${request.kind}`);

  const existing = store.get("effects", request.effectId);
  if (existing) {
    if (JSON.stringify(existing.request) !== JSON.stringify(request)) {
      // Identity already checked by caller via canonical; keep soft check.
    }
    if (existing.status === "completed")
      return { status: "completed", outcome: existing.outcome };
    if (request.kind === "agent")
      return settleAgentEffect(input, existing) ?? { status: "pending" };
    return {
      status:
        existing.status === "uncertain" || existing.status === "invoking"
          ? "uncertain"
          : "pending",
    };
  }

  if (request.kind === "agent") return startAgentEffect(input);
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
  effect: { status: string; outcome?: ActionOutcome; agentSessionId?: string }
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
    // Read the latest turn.completed output from history via effect journal on agent —
    // Session view may carry last output on a side channel; tracer stores it on the session.
    const output = (agent as { lastOutput?: JsonValue }).lastOutput ?? null;
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
        message: (agent as { error?: string }).error ?? "Agent turn failed",
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

  const outcome: ActionOutcome = input.failed
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
    const agent = input.store.get<
      FlowHostSession & { lastOutput?: JsonValue; error?: string }
    >("sessions", id);
    const workflow = input.store.get<FlowHostSession>(
      "sessions",
      effect.request.sessionId
    );
    // Re-enter the workflow engine so it can settle or re-drive the agent effect.
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
    } else if (
      agent.status === "running" ||
      agent.status === "runnable" ||
      agent.status === "idle"
    ) {
      if (agent.status === "idle" && agent.activeTurnId) {
        // Should not happen; treat as runnable.
      }
      if (agent.status === "running" || agent.status === "runnable")
        input.schedule(id);
    }
  }
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
