import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { connectAgents } from "../src/executor.js";
import { deriveExecutorToken } from "../src/derived-credentials.js";
import { AgentsClient } from "../src/client.js";

const APPLICATION_KEY = "a".repeat(64);
const TENANT = "tn_00000000000000000000000001";
const AGENT_ID = "assistant";

/** Independent vector for D§7.3 — must not import deriveExecutorToken. */
function independentVector(
  applicationKey: string,
  tenantId: string,
  agentId: string,
): string {
  const message = Buffer.concat([
    Buffer.from("nylorun/executor/v1", "utf8"),
    Buffer.from([0]),
    Buffer.from(tenantId, "utf8"),
    Buffer.from([0]),
    Buffer.from(agentId, "utf8"),
  ]);
  return createHmac("sha256", Buffer.from(applicationKey, "utf8"))
    .update(message)
    .digest("hex");
}

describe("deriveExecutorToken (C5)", () => {
  it("matches the independently computed fixed vector byte for byte", () => {
    const expected =
      "63db5d4e899ddeda56396c317f21e1622f44ac321d374781c70b39bf0d50b1a2";
    expect(independentVector(APPLICATION_KEY, TENANT, AGENT_ID)).toBe(expected);
    expect(deriveExecutorToken(APPLICATION_KEY, TENANT, AGENT_ID)).toBe(
      expected,
    );
  });

  it("is stable, 64 hex, distinct per agent and from the application key", () => {
    const a = deriveExecutorToken(APPLICATION_KEY, TENANT, "a");
    const b = deriveExecutorToken(APPLICATION_KEY, TENANT, "b");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(APPLICATION_KEY);
    expect(deriveExecutorToken(APPLICATION_KEY, TENANT, "a")).toBe(a);
  });
});

describe("application-mode replica registration (C6)", () => {
  it("two connections with the same key register the same hashes and neither stream ends", async () => {
    const putBodies: unknown[] = [];
    const streamEnded: boolean[] = [false, false];
    const registeredHashes: string[] = [];
    const agent = Agent({
      id: AGENT_ID,
      name: "Assistant",
      instructions: "noop",
      tools: [],
    });

    const fetchFor = (replica: 0 | 1): typeof fetch => {
      return async (url, init) => {
        const path = String(url);
        if (path.endsWith("/health")) {
          return Response.json({
            status: "ok",
            service: "nylorun-runtime",
            version: "0.9.0-beta",
            protocol: { ...HOST_PROTOCOL },
            coreVersion: "0.4.0-beta",
            hostId: "host_00000000000000000000000001",
            pid: 1,
          });
        }
        if (path.includes("/v1/agents/") && init?.method === "PUT") {
          return Response.json({ ok: true });
        }
        if (path.endsWith("/v1/executors") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body));
          putBodies.push(body);
          for (const executor of body.executors as { token: string }[]) {
            registeredHashes.push(executor.token);
          }
          return Response.json({
            executors: body.executors.map((e: { agentId: string }) => ({
              agentId: e.agentId,
              implementationVersion: "test",
              rotated: false,
            })),
          });
        }
        if (path.endsWith("/v1/executors/connect")) {
          const stream = new ReadableStream({
            start(controller) {
              // Keep the stream open until the test closes the connection.
              void controller;
            },
            cancel() {
              streamEnded[replica] = true;
            },
          });
          return new Response(stream, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (path.endsWith("/v1/actions")) {
          return Response.json({ actions: [] });
        }
        throw new Error(`unexpected ${path}`);
      };
    };

    const expectedToken = deriveExecutorToken(
      APPLICATION_KEY,
      TENANT,
      AGENT_ID,
    );
    const app0 = new AgentsClient({
      url: "http://127.0.0.1:8787",
      key: APPLICATION_KEY,
      tenant: TENANT,
      fetch: fetchFor(0),
    });
    const app1 = new AgentsClient({
      url: "http://127.0.0.1:8787",
      key: APPLICATION_KEY,
      tenant: TENANT,
      fetch: fetchFor(1),
    });

    const c0 = connectAgents({
      agents: [agent],
      application: app0,
      implementationVersion: "test",
      onError: () => {},
    });
    const c1 = connectAgents({
      agents: [agent],
      application: app1,
      implementationVersion: "test",
      onError: () => {},
    });

    await Promise.all([c0.ready, c1.ready]);
    expect(putBodies).toHaveLength(2);
    expect(registeredHashes).toEqual([expectedToken, expectedToken]);
    expect(streamEnded).toEqual([false, false]);

    await c0.close();
    await c1.close();
  });
});
