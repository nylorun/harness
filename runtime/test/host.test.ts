import { expect, it } from "vitest";
import { Hono } from "hono";
import { agentContract } from "./contract-suite.js";
import { memoryHistory } from "../src/adapters/journal.js";
import { Runtime, serveAgents } from "../src/server/host.js";
import type { RuntimeAgent, RuntimeEvent } from "../src/contracts.js";

function isolated(agents: readonly RuntimeAgent[]) {
  const runtime = new Runtime({
    observer: () => {},
    durability: memoryHistory(),
  });
  return { runtime, app: serveAgents({ agents, runtime }) };
}

function engine(
  onStop = () => {},
  onClose = async () => {},
  interaction?: "approval" | "response"
): RuntimeAgent {
  return {
    id: "echo",
    name: "Echo",
    manifest: { id: "echo", name: "Echo" },
    close: onClose,
    run({ id = "session" } = {}) {
      return {
        id,
        input(input) {
          const event =
            typeof input === "string"
              ? { kind: "user-message" as const, text: input }
              : "content" in input
              ? { kind: "user-message" as const, content: input.content }
              : { kind: "user-message" as const, text: "hello" };
          if (interaction && !(typeof input === "object" && "kind" in input)) {
            return {
              completed: Promise.resolve({
                status: "waiting" as const,
                events: [
                  {
                    type: "interaction.required",
                    interaction: {
                      id: "question",
                      kind: interaction,
                      prompt: "confirm",
                    },
                  },
                ],
              }),
            };
          }
          const events: RuntimeEvent[] = [
            { type: "input", event },
            { type: "final", output: "hello" },
          ];
          return {
            completed: Promise.resolve({
              status: "completed" as const,
              events,
            }),
          };
        },
        async *stream() {},
        observe() {
          return () => {};
        },
        async stop() {
          onStop();
        },
      };
    },
  };
}
agentContract("Independent engine", (kind) =>
  engine(undefined, undefined, kind)
);
it("advertises root-mounted agent routes without an agents segment", async () => {
  const { runtime, app } = isolated([engine()]);
  try {
    const discovery = await (
      await app.request("http://local/v1/agents")
    ).json();
    expect(discovery.agents[0].manifestUrl).toBe("/echo/manifest.json");
    const manifest = await (
      await app.request("http://local/echo/manifest.json")
    ).json();
    expect(manifest.endpoints.agUi).toBe("/echo/v1/ag-ui");
  } finally {
    await runtime.close();
  }
});

it("advertises and serves routes from the agents mount", async () => {
  const runtime = new Runtime({
    observer: () => {},
    durability: memoryHistory(),
  });
  const app = new Hono();
  app.route(
    "/agents",
    serveAgents({ agents: [engine()], runtime, basePath: "/agents" })
  );
  try {
    const discovery = await (
      await app.request("http://local/agents/v1/agents")
    ).json();
    expect(discovery.agents[0].manifestUrl).toBe("/agents/echo/manifest.json");
    const manifest = await (
      await app.request("http://local/agents/echo/manifest.json")
    ).json();
    expect(manifest.endpoints.agUi).toBe("/agents/echo/v1/ag-ui");
    expect(
      (await app.request("http://local/agents/agents/echo/manifest.json"))
        .status
    ).toBe(404);
    expect(
      (
        await app.request("http://local/agents/echo/v1/ag-ui", {
          method: "POST",
          body: JSON.stringify({
            messages: [{ role: "user", content: "hello" }],
          }),
        })
      ).status
    ).toBe(200);
  } finally {
    await runtime.close();
  }
});

it("stops sessions and then closes agent resources", async () => {
  const steps: string[] = [];
  const { runtime, app } = isolated([
    engine(
      () => steps.push("session"),
      async () => {
        steps.push("agent");
      }
    ),
  ]);
  await app.request("http://local/echo/v1/ag-ui", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
  });
  await runtime.close();
  expect(steps).toEqual(["session", "agent"]);
});
it("rejects duplicate identities", () => {
  expect(() =>
    serveAgents({
      agents: [engine(), engine()],
      runtime: new Runtime({
        observer: () => {},
        durability: memoryHistory(),
      }),
    })
  ).toThrow("unique");
});

it("persists history across restarts without overwriting archived session events", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { localJsonl } = await import("../src/adapters/journal.js");
  const root = await mkdtemp(join(tmpdir(), "runtime-history-"));
  const agents = [engine()];
  const isolatedConfig = {
    observer: () => {},
    durability: localJsonl({ root }),
  };
  let runtime = new Runtime(isolatedConfig);
  let app = serveAgents({ agents, runtime });
  try {
    await app.request("http://local/echo/v1/ag-ui", {
      method: "POST",
      body: JSON.stringify({
        threadId: "saved",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    await runtime.close();
    runtime = new Runtime(isolatedConfig);
    app = serveAgents({ agents, runtime });
    const history = await (
      await app.request("http://local/echo/v1/ag-ui/sessions/saved")
    ).json();
    expect(history.messages).toHaveLength(2);
    const archived = await app.request("http://local/echo/v1/ag-ui", {
      method: "POST",
      body: JSON.stringify({
        threadId: "saved",
        messages: [{ role: "user", content: "again" }],
      }),
    });
    expect(archived.status).toBe(409);
  } finally {
    await runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects path-shaped thread IDs before running the agent", async () => {
  let runs = 0;
  const { runtime, app } = isolated(
    [
      engine(
        () => {},
        async () => {},
        undefined
      ),
    ].map((agent) => ({
      ...agent,
      run(options?: { id?: string }) {
        runs += 1;
        return agent.run(options);
      },
    }))
  );
  try {
    for (const threadId of ["../escape", "a/b", "..", ""]) {
      const response = await app.request("http://local/echo/v1/ag-ui", {
        method: "POST",
        body: JSON.stringify({
          threadId,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(response.status, threadId).toBe(threadId === "" ? 200 : 400);
    }
    expect(runs).toBe(1);
  } finally {
    await runtime.close();
  }
});

it("mounts under a prefix and injects app-provided actor and request metadata", async () => {
  let runOptions:
    | { id?: string; userId?: string; context?: Record<string, unknown> }
    | undefined;
  let received: unknown;
  const base = engine();
  const agent: RuntimeAgent = {
    ...base,
    run(options) {
      runOptions = options;
      const session = base.run(options);
      return {
        ...session,
        input(input) {
          received = input;
          return session.input(input);
        },
      };
    },
  };
  const runtime = new Runtime({
    observer: () => {},
    durability: memoryHistory(),
  });
  const app = new Hono();
  app.route(
    "/api/agents",
    serveAgents({
      agents: [agent],
      runtime,
      basePath: "/api/agents",
      getActor: async () => ({ id: "person-1", context: { tenant: "acme" } }),
      getRequestMetadata: async () => ({ requestId: "request-1" }),
    })
  );
  try {
    const discovery = await (
      await app.request("http://local/api/agents/v1/agents")
    ).json();
    expect(discovery.agents[0].manifestUrl).toBe(
      "/api/agents/echo/manifest.json"
    );
    const manifest = await (
      await app.request("http://local/api/agents/echo/manifest.json")
    ).json();
    expect(manifest.endpoints.agUi).toBe("/api/agents/echo/v1/ag-ui");
    expect(
      new URL(discovery.agents[0].manifestUrl, "http://local/api/agents/")
        .pathname
    ).toBe("/api/agents/echo/manifest.json");
    expect(
      new URL(manifest.endpoints.agUi, "http://local/api/agents/").pathname
    ).toBe("/api/agents/echo/v1/ag-ui");
    await app.request("http://local/api/agents/echo/v1/ag-ui", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(runOptions).toMatchObject({
      userId: "person-1",
      context: { tenant: "acme" },
    });
    expect(received).toMatchObject({ metadata: { requestId: "request-1" } });
  } finally {
    await runtime.close();
  }
});

it("infers each request's mount including parameterized and multiple mounts", async () => {
  const { runtime, app: router } = isolated([engine()]);
  const app = new Hono();
  app.route("/agents", router);
  app.route("/teams/:team/agents", router);
  try {
    for (const prefix of [
      "/agents",
      "/teams/one/agents",
      "/teams/two/agents",
    ]) {
      const discovery = await (await app.request(`${prefix}/v1/agents`)).json();
      expect(discovery.agents[0].manifestUrl).toBe(
        `${prefix}/echo/manifest.json`
      );
      const manifest = await (
        await app.request(discovery.agents[0].manifestUrl)
      ).json();
      expect(manifest.endpoints.sessions).toBe(`${prefix}/echo/v1/sessions`);
      expect(manifest.endpoints.agUi).toBe(`${prefix}/echo/v1/ag-ui`);
    }
  } finally {
    await runtime.close();
  }
});

it("allows local Studio discovery and preflight only in development", async () => {
  const previous = process.env.NYLORUN_DEV;
  try {
    for (const development of [false, true]) {
      if (development) process.env.NYLORUN_DEV = "1";
      else delete process.env.NYLORUN_DEV;
      const { runtime, app } = isolated([engine()]);
      try {
        for (const origin of [
          "http://localhost:4161",
          "https://127.0.0.1:4260",
          "http://[::1]:4161",
          "https://example.com",
          "http://localhost.evil:4161",
          "null",
        ]) {
          const allowed =
            development &&
            !origin.includes("evil") &&
            !origin.includes("example") &&
            origin !== "null";
          for (const path of [
            "/v1/agents",
            "/echo/manifest.json",
            "/echo/v1/sessions",
            "/missing/manifest.json",
          ]) {
            const response = await app.request(path, { headers: { origin } });
            expect(response.headers.get("access-control-allow-origin")).toBe(
              allowed ? origin : null
            );
            expect(
              response.headers.get("access-control-allow-credentials")
            ).toBeNull();
          }
          if (allowed) {
            const stream = await app.request("/echo/v1/ag-ui", {
              method: "POST",
              headers: { origin, "content-type": "application/json" },
              body: JSON.stringify({
                threadId: "cors-stream",
                messages: [{ role: "user", content: "hello" }],
              }),
            });
            expect(stream.headers.get("access-control-allow-origin")).toBe(
              origin
            );
            expect(stream.headers.get("vary")).toContain("Origin");
            expect(stream.headers.get("content-type")).toContain(
              "text/event-stream"
            );
            expect(await stream.text()).toContain("RUN_FINISHED");
          }
          const preflight = await app.request("/echo/v1/ag-ui", {
            method: "OPTIONS",
            headers: {
              origin,
              "access-control-request-method": "POST",
              "access-control-request-headers": "content-type",
            },
          });
          if (allowed) {
            expect(preflight.status).toBe(204);
            expect(
              preflight.headers.get("access-control-allow-methods")
            ).toContain("POST");
            expect(
              preflight.headers.get("access-control-allow-headers")
            ).toContain("content-type");
          }
        }
      } finally {
        await runtime.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.NYLORUN_DEV;
    else process.env.NYLORUN_DEV = previous;
  }
});
