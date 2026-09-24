import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";
import { connectAgents } from "../src/executor.js";
import { deriveExecutorToken } from "../src/derived-credentials.js";

const TENANT = "tn_00000000000000000000000001";
const APPLICATION_KEY = "a".repeat(64);
const EXECUTOR_KEY = "e".repeat(64);
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

function fixtureAgent(id: string) {
  return Agent({
    id,
    name: id,
    instructions: "noop",
    tools: [],
  });
}

describe("connectAgents mode selection (C3)", () => {
  it("selects executor mode when runtime is given", async () => {
    const paths: string[] = [];
    const agent = fixtureAgent("probe");
    const connection = connectAgents({
      agents: [agent],
      implementationVersion: "test",
      runtime: {
        url: URL,
        key: EXECUTOR_KEY,
        tenant: TENANT,
        fetch: async (url, init) => {
          const path = String(url);
          paths.push(`${init?.method ?? "GET"} ${path}`);
          if (path.endsWith("/health")) return healthOk();
          if (path.endsWith("/v1/executors/connect")) {
            return new Response("", {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            });
          }
          if (path.endsWith("/v1/actions")) return Response.json({ actions: [] });
          throw new Error(`unexpected ${path}`);
        },
      },
      onError: () => {},
    });
    await connection.ready;
    await connection.close();
    expect(paths.some((p) => p.includes("/v1/executors/connect"))).toBe(true);
    expect(paths.some((p) => p.includes("PUT") && p.includes("/v1/agents/"))).toBe(
      false,
    );
  });

  it("selects application mode when application is given", async () => {
    const paths: string[] = [];
    const agent = fixtureAgent("probe");
    const application = new AgentsClient({
      url: URL,
      key: APPLICATION_KEY,
      tenant: TENANT,
      fetch: async (url, init) => {
        const path = String(url);
        paths.push(`${init?.method ?? "GET"} ${path}`);
        if (path.endsWith("/health")) return healthOk();
        if (path.includes("/v1/agents/") && init?.method === "PUT") {
          return Response.json({ ok: true });
        }
        if (path.endsWith("/v1/executors") && init?.method === "PUT") {
          return Response.json({
            executors: [
              {
                agentId: "probe",
                implementationVersion: "test",
                rotated: false,
              },
            ],
          });
        }
        if (path.endsWith("/v1/executors/connect")) {
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
      agents: [agent],
      application,
      implementationVersion: "test",
      onError: () => {},
    });
    await connection.ready;
    await connection.close();
    expect(paths.some((p) => p.startsWith("PUT") && p.includes("/v1/agents/"))).toBe(
      true,
    );
    expect(
      paths.some((p) => p.startsWith("PUT") && p.endsWith("/v1/executors")),
    ).toBe(true);
  });

  it("with neither option, resolveConnection role executor selects executor mode", async () => {
    process.env.NYLORUN_RUNTIME_URL = URL;
    process.env.NYLORUN_TENANT = TENANT;
    process.env.NYLORUN_EXECUTOR_KEY = EXECUTOR_KEY;
    const paths: string[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const path = String(url);
      paths.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/health")) return healthOk();
      if (path.endsWith("/v1/executors/connect")) {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (path.endsWith("/v1/actions")) return Response.json({ actions: [] });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    try {
      const connection = connectAgents({
        agents: [fixtureAgent("probe")],
        implementationVersion: "test",
        onError: () => {},
      });
      await connection.ready;
      await connection.close();
    } finally {
      globalThis.fetch = previous;
    }
    expect(paths.some((p) => p.includes("/v1/executors/connect"))).toBe(true);
    expect(paths.some((p) => p.includes("/v1/agents/"))).toBe(false);
  });

  it("with neither option, resolveConnection role application selects application mode", async () => {
    process.env.NYLORUN_RUNTIME_URL = URL;
    process.env.NYLORUN_TENANT = TENANT;
    process.env.NYLORUN_SERVER_KEY = APPLICATION_KEY;
    const paths: string[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      const path = String(url);
      paths.push(`${init?.method ?? "GET"} ${path}`);
      if (path.endsWith("/health")) return healthOk();
      if (path.includes("/v1/agents/") && init?.method === "PUT") {
        return Response.json({ ok: true });
      }
      if (path.endsWith("/v1/executors") && init?.method === "PUT") {
        return Response.json({
          executors: [
            {
              agentId: "probe",
              implementationVersion: "test",
              rotated: false,
            },
          ],
        });
      }
      if (path.endsWith("/v1/executors/connect")) {
        return new Response("", {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      if (path.endsWith("/v1/actions")) return Response.json({ actions: [] });
      throw new Error(`unexpected ${path}`);
    }) as typeof fetch;
    try {
      const connection = connectAgents({
        agents: [fixtureAgent("probe")],
        implementationVersion: "test",
        onError: () => {},
      });
      await connection.ready;
      await connection.close();
    } finally {
      globalThis.fetch = previous;
    }
    expect(
      paths.some((p) => p.startsWith("PUT") && p.includes("/v1/agents/")),
    ).toBe(true);
    expect(
      paths.some((p) => p.startsWith("PUT") && p.endsWith("/v1/executors")),
    ).toBe(true);
  });
});

describe("connectAgents application mode (C4)", () => {
  it("saves each agent, PUTs derived credentials once, connects each, settles ready", async () => {
    const saved: string[] = [];
    const putBodies: unknown[] = [];
    const connectKeys: string[] = [];
    const agents = [fixtureAgent("one"), fixtureAgent("two")];
    let connectCount = 0;

    const application = new AgentsClient({
      url: URL,
      key: APPLICATION_KEY,
      tenant: TENANT,
      fetch: async (url, init) => {
        const path = String(url);
        const headers = new Headers(init?.headers);
        if (path.endsWith("/health")) return healthOk();
        if (path.includes("/v1/agents/") && init?.method === "PUT") {
          const id = path.split("/").pop()!;
          saved.push(decodeURIComponent(id));
          return Response.json({ ok: true });
        }
        if (path.endsWith("/v1/executors") && init?.method === "PUT") {
          putBodies.push(JSON.parse(String(init.body)));
          return Response.json({
            executors: agents.map((a) => ({
              agentId: a.id,
              implementationVersion: "test",
              rotated: false,
            })),
          });
        }
        if (path.endsWith("/v1/executors/connect")) {
          connectCount += 1;
          connectKeys.push(headers.get("authorization") ?? "");
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
      agents,
      application,
      implementationVersion: "test",
      onError: () => {},
    });
    await connection.ready;
    expect(saved.sort()).toEqual(["one", "two"]);
    expect(putBodies).toHaveLength(1);
    const executors = (
      putBodies[0] as {
        executors: {
          agentId: string;
          token: string;
          implementationVersion: string;
        }[];
      }
    ).executors;
    expect(executors).toHaveLength(2);
    expect(executors.map((e) => e.agentId).sort()).toEqual(["one", "two"]);
    for (const e of executors) {
      expect(e.token).toBe(
        deriveExecutorToken(APPLICATION_KEY, TENANT, e.agentId),
      );
      expect(e.implementationVersion).toBe("test");
    }
    expect(connectCount).toBe(2);
    expect(connectKeys.sort()).toEqual(
      [
        `Bearer ${deriveExecutorToken(APPLICATION_KEY, TENANT, "one")}`,
        `Bearer ${deriveExecutorToken(APPLICATION_KEY, TENANT, "two")}`,
      ].sort(),
    );
    await connection.close();
  });
});
