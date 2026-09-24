import { expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/core/compatibility";
import { connectAgents } from "../src/executor.js";
import { Agent } from "@nylorun/core/define";

const TENANT = "tn_00000000000000000000000002";

it("sends Tenant and Protocol headers on executor connect and action traffic", async () => {
  const headersSeen: Headers[] = [];
  const agent = Agent({
    id: "probe",
    name: "Probe",
    instructions: "noop",
    tools: [],
  });
  let resolveReady!: () => void;
  const readyGate = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const connection = connectAgents({
    agents: [agent],
    implementationVersion: "test",
    runtime: {
      url: "http://127.0.0.1:8787",
      key: "executor-key",
      tenant: TENANT,
      fetch: async (url, init) => {
        const path = String(url);
        headersSeen.push(new Headers(init?.headers));
        if (path.endsWith("/health"))
          return Response.json({
            status: "ok",
            service: "nylorun-runtime",
            version: "0.9.0-beta",
            protocol: { ...HOST_PROTOCOL },
            coreVersion: "0.4.0-beta",
            hostId: "host_00000000000000000000000001",
            pid: 1,
          });
        if (path.endsWith("/v1/executors/connect")) {
          resolveReady();
          return new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
            // Empty body ends the SSE loop immediately after discovery.
          });
        }
        if (path.endsWith("/v1/actions")) return Response.json({ actions: [] });
        throw new Error(`unexpected ${path}`);
      },
    },
    onError: () => {},
  });
  await Promise.race([
    connection.ready,
    readyGate.then(() => connection.ready),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("executor ready timeout")), 2000),
    ),
  ]);
  await connection.close();
  const authed = headersSeen.filter((h) => h.get("authorization"));
  expect(authed.length).toBeGreaterThan(0);
  for (const headers of authed) {
    expect(headers.get("authorization")).toBe("Bearer executor-key");
    expect(headers.get(TENANT_HEADER)).toBe(TENANT);
    expect(headers.get(PROTOCOL_HEADER)).toBe(String(PROTOCOL_VERSION));
  }
});
