import { expect, it } from "vitest";
import type { Action, LiveEvent } from "@nylorun/core/contracts";
import type { HostEffect } from "@nylorun/harness/run";
import {
  aggregateWaits,
  applyFlowLeaseExpiry,
  cancelSiblingWork,
  countActiveFlowWork,
  deriveSessionId,
  emitMapItems,
  emitNodeCompleted,
  emitNodeFailed,
  emitNodeStarted,
  emitSwitchSelected,
  fenceWorkflowActions,
  foreignInteractionConflict,
  isFlowToolEffect,
  pathDepth,
  planCancelCascade,
  reconcilePendingAgentEffects,
  reofferOrphanedFnVerifyClaims,
  resolveFlowEffect,
  wakeLinkedWorkflow,
  type FlowHostSession,
  type FlowHostStore,
  type FlowLink,
} from "../../src/core/flow-host.js";
import { resolveFlowLimits } from "../../src/core/limits.js";

function memoryStore(): FlowHostStore & {
  tables: Record<string, Map<string, any>>;
  events: LiveEvent[];
} {
  const tables: Record<string, Map<string, any>> = {
    effects: new Map(),
    actions: new Map(),
    sessions: new Map(),
    links: new Map(),
  };
  const events: LiveEvent[] = [];
  let cursor = 0;
  return {
    tables,
    events,
    get(table, id) {
      return tables[table]?.get(id);
    },
    put(table, id, body) {
      if (!tables[table]) tables[table] = new Map();
      tables[table]!.set(id, body);
    },
    all(table) {
      return [...(tables[table]?.values() ?? [])];
    },
    event(sessionId, turnId, type, payload) {
      const e = {
        sessionId,
        turnId,
        type,
        payload,
        cursor: String(++cursor),
        at: new Date().toISOString(),
      } as LiveEvent;
      events.push(e);
      return e;
    },
  };
}

function baseEffect(
  overrides: Partial<HostEffect> & Pick<HostEffect, "kind" | "effectId">
): HostEffect {
  return {
    sessionId: "wf-1",
    turnId: "turn-1",
    agentId: "ship",
    manifestHash: "hash",
    input: {},
    context: {},
    path: "ship/open-pr",
    key: "ship/open-pr",
    iterations: "-",
    ...overrides,
  };
}

it("WF-R22: deriveSessionId is stable for (workflowSessionId, path)", () => {
  const a = deriveSessionId("wf-1", "review/security");
  const b = deriveSessionId("wf-1", "review/security");
  const c = deriveSessionId("wf-1", "review/style");
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a.startsWith("wf_")).toBe(true);
});

it("WF-EV7: tool-node actions carry path and key on action.pending", () => {
  const store = memoryStore();
  const session: FlowHostSession = {
    id: "wf-1",
    agentId: "ship",
    ownerUserId: "u1",
    manifest: { kind: "workflow" },
    manifestHash: "h",
    implementationVersion: "dev",
    status: "running",
    activeTurnId: "turn-1",
  };
  store.put("sessions", session.id, session);
  const published: LiveEvent[] = [];
  const effect = baseEffect({
    kind: "tool",
    effectId: "e-tool-1",
    path: "ship/open-pr",
    key: "ship/open-pr",
  });
  expect(isFlowToolEffect(effect)).toBe(true);

  const resolution = resolveFlowEffect({
    request: effect,
    store,
    session,
    limits: resolveFlowLimits({ flow: { maxConcurrency: 8 } }),
    putLinkedSession: () => session,
    sendMessage: () => ({ turnId: null }),
    readSession: () => undefined,
    publish: (e) => published.push(e),
    notify: () => {},
    schedule: () => {},
  });
  expect(resolution).toEqual({ status: "pending" });
  const action = store.get<Action>("actions", "e-tool-1");
  expect(action).toMatchObject({
    kind: "tool",
    path: "ship/open-pr",
    key: "ship/open-pr",
    status: "pending",
  });
  expect("capabilityId" in (action as object)).toBe(false);
  expect(published.some((e) => e.type === "node.started")).toBe(true);
  expect(published.some((e) => e.type === "action.pending")).toBe(true);
  const pending = published.find((e) => e.type === "action.pending")!;
  expect(pending.payload).toMatchObject({
    path: "ship/open-pr",
    key: "ship/open-pr",
    kind: "tool",
  });
});

it("WF-L1 / PAR-A4: maxConcurrency queues further ready work", () => {
  const store = memoryStore();
  const session: FlowHostSession = {
    id: "wf-1",
    agentId: "ship",
    ownerUserId: "u1",
    manifest: { kind: "workflow" },
    manifestHash: "h",
    implementationVersion: "dev",
    status: "running",
    activeTurnId: "turn-1",
  };
  store.put("sessions", session.id, session);
  const limits = resolveFlowLimits({ flow: { maxConcurrency: 1 } });
  const start = (id: string) =>
    resolveFlowEffect({
      request: baseEffect({
        kind: "fn",
        effectId: id,
        path: `p/${id}`,
        key: `p/${id}`,
      }),
      store,
      session,
      limits,
      putLinkedSession: () => session,
      sendMessage: () => ({ turnId: null }),
      readSession: () => undefined,
      publish: () => {},
      notify: () => {},
      schedule: () => {},
    });

  expect(start("a1")).toEqual({ status: "pending" });
  expect(store.get("actions", "a1")?.status).toBe("pending");
  expect(start("a2")).toEqual({ status: "pending" });
  expect(store.get("effects", "a2")?.status).toBe("queued");
  expect(store.get("actions", "a2")).toBeUndefined();
  expect(countActiveFlowWork(store, "wf-1", "turn-1")).toBe(1);
});

it("WF-R35 / WF-R38: fn and verify re-offered on lease expiry; tool nodes uncertain", () => {
  const store = memoryStore();
  const fnAction = {
    actionId: "fn-1",
    sessionId: "wf-1",
    turnId: "t",
    agentId: "ship",
    manifestHash: "h",
    implementationVersion: "dev",
    input: {},
    context: {},
    status: "claimed" as const,
    generation: 1,
    claimId: "c1",
    leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
    kind: "fn" as const,
    path: "p",
    key: "p",
  } satisfies Action;
  store.put("actions", fnAction.actionId, fnAction);
  expect(applyFlowLeaseExpiry({ store, action: fnAction })).toBe("reoffer");
  expect(store.get<Action>("actions", "fn-1")?.status).toBe("pending");

  const toolAction = {
    ...fnAction,
    actionId: "tool-1",
    kind: "tool" as const,
    claimId: "c2",
    status: "claimed" as const,
    leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  store.put("actions", toolAction.actionId, toolAction);
  store.put("effects", "tool-1", { request: {}, status: "pending" });
  expect(applyFlowLeaseExpiry({ store, action: toolAction as Action })).toBe(
    "uncertain"
  );
  expect(store.get<Action>("actions", "tool-1")?.status).toBe("uncertain");
});

it("SD-P7: reofferOrphanedFnVerifyClaims on start", () => {
  const store = memoryStore();
  store.put("actions", "v1", {
    actionId: "v1",
    sessionId: "wf-1",
    turnId: "t",
    agentId: "ship",
    manifestHash: "h",
    implementationVersion: "dev",
    input: {},
    context: {},
    status: "claimed",
    generation: 2,
    claimId: "c",
    leaseExpiresAt: new Date().toISOString(),
    kind: "verify",
    path: "loop",
    key: "loop",
  });
  store.put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
    activeTurnId: "t",
  });
  expect(reofferOrphanedFnVerifyClaims(store)).toBe(1);
  expect(store.get<Action>("actions", "v1")?.status).toBe("pending");
  expect(store.get<FlowHostSession>("sessions", "wf-1")?.status).toBe(
    "runnable"
  );
});

it("PAR-R6: cancelSiblingWork cancels pending, uncertains claimed, lists agents", () => {
  const store = memoryStore();
  store.put("sessions", "wf-1", {
    id: "wf-1",
    status: "running",
    activeTurnId: "turn-1",
  });
  const agentId = deriveSessionId("wf-1", "review/style");
  store.put("sessions", agentId, {
    id: agentId,
    status: "running",
    activeTurnId: "at-1",
  });
  store.put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "review/style",
    effectId: "e-style",
    turnId: "turn-1",
  } satisfies FlowLink);

  store.put("actions", "pending-1", {
    actionId: "pending-1",
    sessionId: "wf-1",
    turnId: "turn-1",
    status: "pending",
    kind: "tool",
    path: "review/tests",
    key: "review/tests",
  });
  store.put("actions", "claimed-1", {
    actionId: "claimed-1",
    sessionId: "wf-1",
    turnId: "turn-1",
    status: "claimed",
    kind: "tool",
    path: "review/tests/x",
    key: "review/tests",
  });
  store.put("effects", "pending-1", { status: "pending" });
  store.put("effects", "claimed-1", { status: "pending" });

  const result = cancelSiblingWork({
    store,
    workflowSessionId: "wf-1",
    turnId: "turn-1",
    siblingPaths: ["review/style", "review/tests"],
  });
  expect(result.agentSessionIds).toContain(agentId);
  expect(result.cancelledActions).toContain("pending-1");
  expect(result.uncertainActions).toContain("claimed-1");
  expect(store.get<Action>("actions", "pending-1")?.status).toBe("cancelled");
  expect(store.get<Action>("actions", "claimed-1")?.status).toBe("uncertain");
});

it("WF-R53 / SD-P11: planCancelCascade orders agents deepest-first", () => {
  const store = memoryStore();
  store.put("sessions", "wf-1", { id: "wf-1" });
  const shallow = deriveSessionId("wf-1", "a");
  const deep = deriveSessionId("wf-1", "a/b/c");
  store.put("sessions", shallow, { id: shallow });
  store.put("sessions", deep, { id: deep });
  store.put("links", shallow, {
    workflowSessionId: "wf-1",
    path: "a",
    effectId: "e1",
    turnId: "t",
  });
  store.put("links", deep, {
    workflowSessionId: "wf-1",
    path: "a/b/c",
    effectId: "e2",
    turnId: "t",
  });
  expect(pathDepth("a/b/c")).toBe(3);
  const plan = planCancelCascade({
    store,
    workflowSessionId: "wf-1",
    turnId: "t",
  });
  expect(plan.agentSessionIds[0]).toBe(deep);
  expect(plan.agentSessionIds[1]).toBe(shallow);
});

it("WF-R53: fenceWorkflowActions pending→cancelled, claimed→uncertain", () => {
  const store = memoryStore();
  store.put("actions", "p", {
    actionId: "p",
    sessionId: "wf-1",
    turnId: "t",
    status: "pending",
  });
  store.put("actions", "c", {
    actionId: "c",
    sessionId: "wf-1",
    turnId: "t",
    status: "claimed",
  });
  store.put("effects", "p", { status: "pending", request: { effectId: "p" } });
  store.put("effects", "c", { status: "pending", request: { effectId: "c" } });
  store.put("effects", "q", {
    status: "queued",
    request: { effectId: "q", sessionId: "wf-1", turnId: "t" },
  });
  const fenced = fenceWorkflowActions({
    store,
    workflowSessionId: "wf-1",
    turnId: "t",
  });
  expect(fenced.cancelled).toEqual(expect.arrayContaining(["p", "q"]));
  expect(fenced.uncertain).toContain("c");
});

it("WF-R51: aggregateWaits lists linked agent interactions with owning session and path", () => {
  const store = memoryStore();
  store.put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
    waits: undefined,
  });
  const agentId = deriveSessionId("wf-1", "polish/writer");
  store.put("sessions", agentId, {
    id: agentId,
    status: "paused",
    waits: [
      {
        invocationId: "inv-1",
        interaction: { id: "int-1", kind: "approval" },
        status: "interaction",
      },
    ],
  });
  store.put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "polish/writer",
    effectId: "e",
    turnId: "t",
  });
  const waits = aggregateWaits({ store, workflowSessionId: "wf-1" });
  expect(waits).toEqual([
    expect.objectContaining({
      sessionId: agentId,
      path: "polish/writer",
      interactionId: "int-1",
      kind: "approval",
    }),
  ]);
});

it("WF-R52 / LOOP-A4: foreignInteractionConflict returns 409 naming owner session", () => {
  const store = memoryStore();
  const agentId = deriveSessionId("wf-1", "polish/writer");
  store.put("sessions", "wf-1", { id: "wf-1", status: "paused", waits: [] });
  store.put("sessions", agentId, {
    id: agentId,
    status: "paused",
    waits: [{ interaction: { id: "int-9", kind: "approval" } }],
  });
  store.put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "polish/writer",
    effectId: "e",
    turnId: "t",
  });
  const conflict = foreignInteractionConflict({
    store,
    workflowSessionId: "wf-1",
    interactionId: "int-9",
  });
  expect(conflict).toEqual({
    status: 409,
    message: `Interaction belongs to session ${agentId}`,
    ownerSessionId: agentId,
  });
});

it("WF-R54: wakeLinkedWorkflow records agent.cancelled", () => {
  const store = memoryStore();
  const agentId = deriveSessionId("wf-1", "branch");
  store.put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
    activeTurnId: "turn-1",
  });
  store.put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "branch",
    effectId: "eff-1",
    turnId: "turn-1",
  });
  store.put("effects", "eff-1", { status: "pending", request: {} });
  let scheduled = "";
  wakeLinkedWorkflow({
    agentSessionId: agentId,
    store,
    cancelled: true,
    schedule: (sid) => {
      scheduled = sid;
    },
    publish: () => {},
  });
  expect(store.get("effects", "eff-1")?.outcome?.value).toMatchObject({
    kind: "failed",
    code: "agent.cancelled",
  });
  expect(scheduled).toBe("wf-1");
});

it("WF-EV1–EV6: workflow event helpers emit required payloads", () => {
  const store = memoryStore();
  const session: FlowHostSession = {
    id: "wf-1",
    agentId: "ship",
    ownerUserId: "u",
    manifest: { kind: "workflow" },
    manifestHash: "h",
    implementationVersion: "dev",
    status: "running",
    activeTurnId: "t",
  };
  const published: LiveEvent[] = [];
  const pub = { store, session, publish: (e: LiveEvent) => published.push(e) };
  emitNodeStarted(pub, {
    path: "a",
    kind: "agent",
    key: "a",
    iterations: "1",
  });
  emitNodeCompleted(pub, { path: "a", iterations: "1" });
  emitNodeFailed(pub, {
    path: "a",
    error: { code: "agent.failed", message: "x", path: "a" },
  });
  emitSwitchSelected(pub, { path: "sw", case: "left" });
  emitMapItems(pub, { path: "m", count: 3 });
  const types = published.map((e) => e.type);
  expect(types).toEqual([
    "node.started",
    "node.completed",
    "node.failed",
    "switch.selected",
    "map.items",
  ]);
});

it("WF-C9: reconcilePendingAgentEffects wakes on settled linked turns", () => {
  const store = memoryStore();
  const agentId = deriveSessionId("wf-1", "writer");
  store.put("sessions", "wf-1", {
    id: "wf-1",
    status: "waiting",
    activeTurnId: "turn-1",
  });
  store.put("sessions", agentId, {
    id: agentId,
    status: "completed",
    lastOutput: "done",
    activeTurnId: null,
  });
  store.put("links", agentId, {
    workflowSessionId: "wf-1",
    path: "writer",
    effectId: "eff",
    turnId: "turn-1",
  });
  store.put("effects", "eff", {
    status: "pending",
    agentSessionId: agentId,
    request: { kind: "agent", sessionId: "wf-1", turnId: "turn-1" },
  });
  const scheduled: string[] = [];
  reconcilePendingAgentEffects({
    store,
    schedule: (sid) => scheduled.push(sid),
    publish: () => {},
  });
  expect(store.get("effects", "eff")?.status).toBe("completed");
  expect(scheduled).toContain("wf-1");
});
