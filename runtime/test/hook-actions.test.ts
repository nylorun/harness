import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { startTestTenant } from "./support/tenant.js";

const APP = "server-token-value-aaaaaaaa";
import { Store } from "../src/core/store.js";

const server = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};
const executor = {
  authorization: "Bearer executor-token-value",
  "content-type": "application/json",
};

const hooked = Agent({ id: "hooked", name: "Hooked" })
  .use({ id: "one", before: { step: () => ({}) } })
  .use({ id: "two", before: { step: () => ({}) } })
  .build();

async function start(leaseMs?: number) {
  return startTestTenant({
    applicationKey: APP,
    executors: [
      { token: "executor-token-value", agentId: "hooked", implementationVersion: "dev" },
    ],
    modelProvider: async () => ({ output: [{ type: "text", text: "done" }] }),
    ...(leaseMs === undefined ? {} : { leaseMs }),
  });
}

async function openTurn(url: string) {
  const put = (path: string, body: unknown) =>
    fetch(`${url}${path}`, { method: "PUT", headers: server, body: JSON.stringify(body) });
  expect(
    (
      await put("/v1/agents/hooked", {
        requestId: "put-1",
        manifest: hooked.manifest,
        implementationVersion: "dev",
      })
    ).ok
  ).toBe(true);
  expect(
    (await put("/v1/sessions/s1", { requestId: "s-1", agentId: "hooked", ownerUserId: "u" })).ok
  ).toBe(true);
  const message = await fetch(`${url}/v1/sessions/s1/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify({
      type: "message",
      requestId: "msg-1",
      idempotencyKey: "msg-1",
      content: "hello",
    }),
  });
  expect(message.ok).toBe(true);
}

async function pendingActions(url: string) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const listed = await fetch(`${url}/v1/actions`, {
      headers: { authorization: executor.authorization },
    });
    const { actions } = (await listed.json()) as {
      actions: { actionId: string; kind: string; status: string; hook?: unknown }[];
    };
    const pending = actions.filter((action) => action.status === "pending");
    if (pending.length) return pending;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

async function claim(url: string, actionId: string, requestId: string) {
  const response = await fetch(`${url}/v1/actions/${actionId}/claim`, {
    method: "POST",
    headers: executor,
    body: JSON.stringify({ requestId, implementationVersion: "dev" }),
  });
  expect(response.ok).toBe(true);
  return (await response.json()) as { claimId: string; generation: number };
}

it("sends one hook action per point and re-delivers it when a lease expires", async () => {
  const runtime = await start(150);
  try {
    await openTurn(runtime.url);
    const [action, ...rest] = await pendingActions(runtime.url);
    expect(rest).toHaveLength(0);
    expect(action).toMatchObject({
      kind: "hook",
      hook: { at: "before", scope: "step", capabilityIds: ["one", "two"] },
    });
    const first = await claim(runtime.url, action!.actionId, "claim-1");

    // Never answer the first claim: the lease expires and the hook is delivered again.
    const again = await pendingActions(runtime.url);
    expect(again.map((item) => item.actionId)).toEqual([action!.actionId]);
    const second = await claim(runtime.url, action!.actionId, "claim-2");
    expect(second.generation).toBeGreaterThan(first.generation);

    const result = await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
      method: "POST",
      headers: executor,
      body: JSON.stringify({
        type: "action_result",
        requestId: "result-1",
        idempotencyKey: "result-1",
        actionId: action!.actionId,
        claimId: second.claimId,
        generation: second.generation,
        outcome: { value: { results: { one: {}, two: {} } } },
      }),
    });
    expect(result.ok).toBe(true);

    let types: string[] = [];
    for (let attempt = 0; attempt < 150 && !types.includes("turn.completed"); attempt += 1) {
      const items = await fetch(`${runtime.url}/v1/sessions/s1/items`, {
        headers: { authorization: server.authorization },
      });
      types = ((await items.json()) as { items: { type: string }[] }).items.map(
        (item) => item.type
      );
      if (!types.includes("turn.completed"))
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(types).toContain("turn.completed");
    expect(types).not.toContain("action.uncertain");
  } finally {
    await runtime.close();
  }
});

it("ends turns and hook actions left by a schema 3 manifest on startup", async () => {
  const runtime = await startTestTenant({
    applicationKey: APP,
    retainRoot: true,
    executors: [
      { token: "executor-token-value", agentId: "hooked", implementationVersion: "dev" },
    ],
    modelProvider: async () => ({ output: [{ type: "text", text: "done" }] }),
  });
  const { root, tenantId } = runtime;
  const sqlitePath = join(root, "tenants", tenantId, "tenant.sqlite");
  try {
    await openTurn(runtime.url);
    await pendingActions(runtime.url);
  } finally {
    await runtime.close();
  }
  const store = new Store(sqlitePath, tenantId);
  store.tx(() => {
    const session = store.get("sessions", "s1");
    session.manifest = { ...session.manifest, manifestSchemaVersion: 3 };
    store.put("sessions", "s1", session);
    store.put("actions", "legacy", {
      actionId: "legacy",
      sessionId: "s1",
      kind: "beforeModelCall",
      status: "pending",
    });
  });
  store.db.close();

  const restarted = await startTestTenant({
    applicationKey: APP,
    hostRoot: root,
    tenantId,
    executors: [
      { token: "executor-token-value", agentId: "hooked", implementationVersion: "dev" },
    ],
    modelProvider: async () => ({ output: [{ type: "text", text: "done" }] }),
  });
  try {
    const listed = await fetch(`${restarted.url}/v1/actions`, {
      headers: { authorization: executor.authorization },
    });
    const { actions } = (await listed.json()) as { actions: { actionId: string }[] };
    expect(actions.map((item) => item.actionId)).not.toContain("legacy");
  } finally {
    await restarted.close();
  }
  const after = new Store(sqlitePath, tenantId);
  try {
    expect(after.get("actions", "legacy")).toMatchObject({ status: "cancelled" });
    expect(after.get("sessions", "s1")).toMatchObject({ status: "failed", activeTurnId: null });
  } finally {
    after.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
