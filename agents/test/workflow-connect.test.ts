import { afterEach, describe, expect, it } from "vitest";
import { Agent, Loop } from "@nylorun/core/define";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";
import { connectAgents } from "../src/executor.js";

const TENANT = "tn_00000000000000000000000001";
const APPLICATION_KEY = "a".repeat(64);
const URL = "http://127.0.0.1:8787";

afterEach(() => {
  delete process.env.NYLORUN_RUNTIME_URL;
  delete process.env.NYLORUN_TENANT;
  delete process.env.NYLORUN_SERVER_KEY;
  delete process.env.NYLORUN_EXECUTOR_KEY;
});

function healthOk() {
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

describe("connectAgents workflows (WF-R3 / WF-C5 / SD-C1)", () => {
  it("saves and connects the workflow plus referenced agents", async () => {
    const saved: string[] = [];
    const connected: string[] = [];
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const workflow = Loop({
      id: "polish",
      run: writer,
      verify: () => ({ pass: true as const }),
      decide: () => ({ output: "done" }),
    });

    const application = new AgentsClient({
      url: URL,
      key: APPLICATION_KEY,
      tenant: TENANT,
      fetch: async (url, init) => {
        const path = String(url);
        if (path.endsWith("/health")) return healthOk();
        if (path.includes("/v1/agents/") && init?.method === "PUT") {
          saved.push(decodeURIComponent(path.split("/").pop()!));
          return Response.json({ ok: true });
        }
        if (path.endsWith("/v1/executors") && init?.method === "PUT") {
          const body = JSON.parse(String(init.body)) as {
            executors: { agentId: string }[];
          };
          return Response.json({
            executors: body.executors.map((e) => ({
              agentId: e.agentId,
              implementationVersion: "test",
              rotated: false,
            })),
          });
        }
        if (path.endsWith("/v1/executors/connect")) {
          connected.push("connect");
          return new Response("", {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        if (path.endsWith("/v1/actions")) return Response.json({ actions: [] });
        throw new Error(`unexpected ${path}`);
      },
    });

    const connection = connectAgents({
      agents: [workflow],
      application,
      implementationVersion: "test",
      onError: () => {},
    });
    await connection.ready;
    await connection.close();
    expect(new Set(saved)).toEqual(new Set(["polish", "writer"]));
    expect(saved.filter((id) => id === "polish")).toHaveLength(1);
    expect(connected).toHaveLength(2);
  });
});
