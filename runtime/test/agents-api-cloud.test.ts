import { describe, expect, it } from "vitest";
import { Agent } from "@nylorun/harness";
import {
  AgentsApiClient,
  AgentsApiError,
  CURSOR_EXPIRED,
  RUNTIME_RETIRED,
  SANDBOX_AGENTS_API_URL,
  SESSION_BUSY,
  UNAUTHORIZED,
  createExecutorSurfaces,
  createLazyCloudSessionHandle,
  infoToWireUser,
  openCloudSession,
  resolveCloudConfig,
  shouldRerunOnRedelivery,
  Runtime,
} from "../src/index.js";

type MockCall = {
  method: string;
  url: string;
  body?: unknown;
  headers: Headers;
};

function sseBody(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function mockFetch(handler: (call: MockCall) => Promise<Response> | Response) {
  const calls: MockCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string" && init.body)
      body = JSON.parse(init.body);
    const call = { method, url, body, headers };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

const cloudBase = {
  baseUrl: "https://acme.nylorun.app",
  credentials: { token: "nyl_sk_test", mode: "server_key" as const },
};

describe("Agents API cloud client contracts", () => {
  it("resolveCloudConfig enables cloud from URL+key (MODE=cloud optional; MODE=local forces local)", () => {
    expect(
      resolveCloudConfig({
        NYLORUN_MODE: "cloud",
        NYLORUN_URL: "https://acme.nylorun.app",
        NYLORUN_SECRET_KEY: "nyl_sk_x",
      }),
    ).toMatchObject({
      baseUrl: "https://acme.nylorun.app",
      credentials: { mode: "server_key", token: "nyl_sk_x" },
    });
    // DX: URL + secret key alone selects Cloud destination.
    expect(
      resolveCloudConfig({
        NYLORUN_URL: SANDBOX_AGENTS_API_URL,
        NYLORUN_SECRET_KEY: "nyl_sk_x",
      }),
    ).toMatchObject({
      baseUrl: SANDBOX_AGENTS_API_URL,
      credentials: { mode: "server_key", token: "nyl_sk_x" },
    });
    expect(
      resolveCloudConfig({
        NYLORUN_MODE: "local",
        NYLORUN_URL: "https://acme.nylorun.app",
        NYLORUN_SECRET_KEY: "nyl_sk_x",
      }),
    ).toBeUndefined();
    expect(
      resolveCloudConfig({
        NYLORUN_URL: SANDBOX_AGENTS_API_URL,
      }),
    ).toBeUndefined();
  });

  it("maps Runtime info to wire user without renaming SDK options", () => {
    expect(infoToWireUser({ id: "u_1", tenantId: "acme" })).toEqual({
      id: "u_1",
      tenantId: "acme",
    });
  });

  it("registers agent manifest without inventing model, opens session with wire user", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.method === "PUT" && call.url.includes("/v1/agents/"))
        return Response.json({ id: "support", hash: "abc" });
      if (call.method === "PUT" && call.url.includes("/v1/sessions/"))
        return Response.json({ id: "ses_1" });
      return new Response("not found", { status: 404 });
    });
    const client = new AgentsApiClient({ ...cloudBase, fetch: fetchImpl });
    const agent = Agent({ id: "support", name: "Support" }).build();
    await openCloudSession(client, agent, {
      id: "ses_1",
      info: { id: "u_1", tenantId: "acme" },
      state: { customer: { name: "Ada" } },
    });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.url).toBe("https://acme.nylorun.app/v1/agents/support");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer nyl_sk_test");
    const reg = calls[0]?.body as { requestId: string; manifest: Record<string, unknown> };
    expect(reg.requestId).toMatch(/^req_/);
    expect(reg.manifest).toMatchObject({ id: "support", name: "Support" });
    expect(reg.manifest).not.toHaveProperty("model");
    expect(calls[1]?.body).toMatchObject({
      agentId: "support",
      user: { id: "u_1", tenantId: "acme" },
      state: { customer: { name: "Ada" } },
    });
  });

  it("throws unauthorized on sandbox-shaped 401 auth rejection", async () => {
    const { fetchImpl } = mockFetch(() =>
      Response.json(
        {
          status: "rejected",
          code: UNAUTHORIZED,
          message: "Invalid or missing server key",
        },
        { status: 401 },
      ),
    );
    const client = new AgentsApiClient({ ...cloudBase, fetch: fetchImpl });
    await expect(
      client.registerAgent("probe", { id: "probe" }),
    ).rejects.toMatchObject({
      code: UNAUTHORIZED,
      status: 401,
      message: "Invalid or missing server key",
    });
    await expect(
      client.postMessage("s1", "hi"),
    ).rejects.toMatchObject({
      code: UNAUTHORIZED,
      status: 401,
    });
    const err = new AgentsApiError("Invalid or missing server key", {
      code: UNAUTHORIZED,
      status: 401,
    });
    expect(err.isUnauthorized).toBe(true);
  });

  it("accepts message commands and surfaces session_busy without steering", async () => {
    let busy = false;
    const { fetchImpl } = mockFetch((call) => {
      if (call.url.endsWith("/v1/agents/bot"))
        return Response.json({ ok: true });
      if (call.method === "PUT" && call.url.includes("/sessions/"))
        return Response.json({ id: "s1" });
      if (call.method === "POST" && call.url.endsWith("/events")) {
        const body = call.body as { type: string; text?: string };
        expect(body.type).toBe("message");
        expect(body).toHaveProperty("idempotencyKey");
        if (busy) {
          return Response.json(
            {
              status: "rejected",
              code: SESSION_BUSY,
              turnId: "turn_123",
              message: "Session has an active turn. Wait for settlement or cancel.",
              requestId: "req_124",
            },
            { status: 409 },
          );
        }
        busy = true;
        return Response.json({
          status: "accepted",
          turnId: "turn_123",
          cursor: "cur_1",
          requestId: "req_123",
        });
      }
      return new Response("nope", { status: 500 });
    });
    const client = new AgentsApiClient({ ...cloudBase, fetch: fetchImpl });
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    const session = await openCloudSession(client, agent, { id: "s1" });
    const accepted = await session.input("Where is order A-1042?");
    expect(accepted).toEqual({
      status: "accepted",
      turnId: "turn_123",
      cursor: "cur_1",
    });
    expect(accepted).not.toHaveProperty("steered");
    const rejected = await session.input("second");
    expect(rejected.status).toBe("rejected");
    expect(rejected.error?.code).toBe(SESSION_BUSY);
    expect(rejected.turnId).toBe("turn_123");
    expect(rejected).not.toHaveProperty("steered");
  });

  it("streams SSE with after cursor and dedupes by cursor", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      expect(call.method).toBe("GET");
      expect(call.url).toContain("/v1/sessions/s1/events?after=cur_0");
      expect(call.headers.get("accept")).toBe("text/event-stream");
      return new Response(
        sseBody([
          {
            type: "turn.started",
            cursor: "cur_1",
            at: "2026-09-19T12:00:00.000Z",
            sessionId: "s1",
            turnId: "t1",
          },
          {
            type: "text.delta",
            cursor: "cur_2",
            sessionId: "s1",
            turnId: "t1",
            text: "Order ",
          },
          {
            type: "text.delta",
            cursor: "cur_2",
            sessionId: "s1",
            turnId: "t1",
            text: "dup",
          },
          {
            type: "turn.settled",
            cursor: "cur_3",
            sessionId: "s1",
            turnId: "t1",
            result: { status: "completed", output: "done" },
          },
        ]),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    const client = new AgentsApiClient({ ...cloudBase, fetch: fetchImpl });
    const events = [];
    for await (const event of client.streamEvents("s1", { after: "cur_0" }))
      events.push(event);
    expect(calls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual([
      "turn.started",
      "text.delta",
      "turn.settled",
    ]);
  });

  it("throws cursor_expired on SSE 410", async () => {
    const { fetchImpl } = mockFetch(() =>
      Response.json(
        { status: "rejected", code: CURSOR_EXPIRED, message: "expired" },
        { status: 410 },
      ),
    );
    const client = new AgentsApiClient({ ...cloudBase, fetch: fetchImpl });
    await expect(client.streamEvents("s1", { after: "old" }).next()).rejects.toMatchObject({
      code: CURSOR_EXPIRED,
      status: 410,
    });
  });

  it("history handoff returns items + cursor", async () => {
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    const { fetchImpl } = mockFetch((call) => {
      if (call.method === "PUT") return Response.json({ ok: true });
      if (call.url.endsWith("/items"))
        return Response.json({
          items: [
            { type: "message", role: "user", text: "hi" },
            { type: "message", role: "assistant", text: "hello" },
          ],
          cursor: "handoff_9",
        });
      return new Response("no", { status: 404 });
    });
    const client = new AgentsApiClient({ ...cloudBase, fetch: fetchImpl });
    const session = await openCloudSession(client, agent, { id: "s1" });
    const snapshot = await session.historySnapshot();
    expect(snapshot).toEqual({
      items: [
        { type: "message", role: "user", text: "hi" },
        { type: "message", role: "assistant", text: "hello" },
      ],
      cursor: "handoff_9",
    });
    expect(await session.history()).toHaveLength(2);
  });

  it("posts answer and cancel while allowing busy-session interaction commands", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.method === "PUT") return Response.json({ ok: true });
      if (call.method === "POST" && call.url.endsWith("/events")) {
        const body = call.body as { type: string };
        return Response.json({
          status: "accepted",
          turnId: "turn_1",
          cursor: "c1",
          requestId: "r1",
          echo: body.type,
        });
      }
      return new Response("no", { status: 404 });
    });
    const client = new AgentsApiClient({ ...cloudBase, fetch: fetchImpl });
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    const session = await openCloudSession(client, agent, { id: "s1" });
    await session.approve("int_1", true);
    await session.respond("int_2", { choice: "a" });
    await session.cancel();
    const eventPosts = calls.filter(
      (c) => c.method === "POST" && c.url.endsWith("/events"),
    );
    expect(eventPosts.map((c) => (c.body as { type: string }).type)).toEqual([
      "answer",
      "answer",
      "cancel",
    ]);
  });

  it("executor surfaces claim heartbeat and action_result", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.url.endsWith("/actions"))
        return Response.json({
          actions: [
            {
              type: "function_call",
              actionId: "act_789",
              callId: "call_9f",
              name: "lookup",
              redelivery: false,
            },
          ],
        });
      if (call.url.endsWith("/claim"))
        return Response.json({
          leaseGeneration: 1,
          token: "lease_tok",
          deadline: "2026-09-19T12:00:30.000Z",
        });
      if (call.url.endsWith("/heartbeat"))
        return Response.json({ ok: true });
      if (call.url.endsWith("/events"))
        return Response.json({
          status: "accepted",
          turnId: "t1",
          cursor: "c1",
          requestId: "r1",
        });
      return new Response("no", { status: 404 });
    });
    const client = new AgentsApiClient({ ...cloudBase, fetch: fetchImpl });
    const surfaces = createExecutorSurfaces(client);
    const listed = await surfaces.listActions("s1");
    expect(listed.actions?.[0]?.actionId).toBe("act_789");
    await surfaces.claimAction("act_789", { executorCodeVersion: "git:abc" });
    await surfaces.heartbeatAction("act_789", { leaseGeneration: 1 });
    await surfaces.postActionResult("s1", {
      actionId: "act_789",
      callId: "call_9f",
      leaseGeneration: 1,
      executorCodeVersion: "git:abc",
      success: true,
      output: { status: "shipped" },
    });
    expect(calls.some((c) => c.url.endsWith("/claim"))).toBe(true);
    expect(
      calls.find((c) => c.url.endsWith("/events"))?.body,
    ).toMatchObject({
      type: "action_result",
      actionId: "act_789",
      leaseGeneration: 1,
    });
    expect(shouldRerunOnRedelivery("read", true)).toBe("rerun");
    expect(shouldRerunOnRedelivery(undefined, true)).toBe("inspect");
  });

  it("Runtime.openSession routes to Cloud when config.cloud is set", async () => {
    const { fetchImpl, calls } = mockFetch((call) => {
      if (call.method === "PUT") return Response.json({ ok: true });
      if (call.method === "POST")
        return Response.json({
          status: "accepted",
          turnId: "t1",
          cursor: "c1",
          requestId: "r1",
        });
      return new Response("no", { status: 404 });
    });
    const runtime = new Runtime({
      cloud: { ...cloudBase, fetch: fetchImpl },
      onModelCall: async () => {
        throw new Error("local onModelCall must not run for Cloud destination");
      },
    });
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    const session = runtime.openSession(agent, {
      id: "ses_cloud",
      info: { id: "u1" },
    });
    const accepted = await session.input("hello");
    expect(accepted.status).toBe("accepted");
    expect(calls.some((c) => c.url.includes("/v1/agents/bot"))).toBe(true);
    expect(calls.some((c) => c.url.includes("/v1/sessions/ses_cloud"))).toBe(
      true,
    );
    await runtime.close();
  });

  it("surfaces runtime_retired on rejected open-path command", async () => {
    const { fetchImpl } = mockFetch((call) => {
      if (call.method === "PUT" && call.url.includes("/agents/"))
        return Response.json({ ok: true });
      if (call.method === "PUT" && call.url.includes("/sessions/"))
        return Response.json({ ok: true });
      return Response.json(
        {
          status: "rejected",
          code: RUNTIME_RETIRED,
          message: "Open a new session",
        },
        { status: 409 },
      );
    });
    const client = new AgentsApiClient({ ...cloudBase, fetch: fetchImpl });
    const agent = Agent({ id: "bot", name: "Bot" }).build();
    const session = createLazyCloudSessionHandle(client, agent, { id: "old" });
    const rejected = await session.input("hi");
    expect(rejected.status).toBe("rejected");
    expect(rejected.error?.code).toBe(RUNTIME_RETIRED);
  });

  it("AgentsApiError classifies busy, cursor, and unauthorized codes", () => {
    const busy = new AgentsApiError("busy", {
      code: SESSION_BUSY,
      status: 409,
    });
    expect(busy.isSessionBusy).toBe(true);
    const expired = new AgentsApiError("gone", {
      code: CURSOR_EXPIRED,
      status: 410,
    });
    expect(expired.isCursorExpired).toBe(true);
    const unauthorized = new AgentsApiError("nope", {
      code: UNAUTHORIZED,
      status: 401,
    });
    expect(unauthorized.isUnauthorized).toBe(true);
  });
});
