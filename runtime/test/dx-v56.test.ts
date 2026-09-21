import { openSession, setDefaultRuntime, listSessions, getSession, deleteSession } from "../src/session/api.js";
import { describe, expect, it, vi } from "vitest";
import { Agent, tool } from "@nylorun/core/define";
import { z } from "zod";
import {
  Runtime,
  SessionHost,
  memorySessions,
  serveAgents,
} from "./legacy-api.js";

describe("Runtime DX v5.6", () => {
  it("seeds ExecutionState with manifestHash via createRunState", async () => {
    const host = new SessionHost(memorySessions());
    const agent = Agent({ id: "a", name: "A" }).build();
    await host.submit(agent, "s", "hi", {
      onModelCall: async () => "ok",
    });
    const document = await host.read("a", "s");
    expect(document?.state?.manifestHash).toBe(agent.hash);
    expect(document?.state?.manifestHash).toBeTruthy();
    await host.close();
  });

  it("rejects resume when saved manifestHash does not match the agent", async () => {
    const store = memorySessions();
    const host = new SessionHost(store);
    const first = Agent({ id: "a", name: "A", instructions: "one" }).build();
    await host.submit(first, "s", "hi", { onModelCall: async () => "ok" });
    const saved = await store.get("a", "s");
    expect(saved?.state?.manifestHash).toBe(first.hash);

    const other = Agent({ id: "a", name: "A", instructions: "two" }).build();
    expect(other.hash).not.toBe(first.hash);
    await expect(
      new SessionHost(store).submit(other, "s", "again", {
        onModelCall: async () => "nope",
      }),
    ).rejects.toMatchObject({ code: "execution.incompatible" });
  });

  it("seeds session memory from openSession state option", async () => {
    let calls = 0;
    const runtime = new Runtime({
      sessions: memorySessions(),
      onModelCall: async () => {
        calls += 1;
        if (calls === 1)
          return {
            output: [{ type: "tool-call", id: "1", name: "read", args: {} }],
          };
        return "done";
      },
    });
    const agent = Agent({ id: "support", name: "Support" })
      .use({
        id: "t",
        tools: [
          tool({
            name: "read",
            input: z.object({}),
            async run(_args, ctx) {
              return { customer: ctx.state.get("customer") };
            },
          }),
        ],
      })
      .build();
    const session = runtime.openSession(agent, {
      info: { id: "u1" },
      state: { customer: "acme" },
    });
    const accepted = await session.input("hello");
    expect(accepted.status).toBe("accepted");
    const document = await runtime.getSession("support", session.id);
    expect(document?.state?.state).toMatchObject({ customer: "acme" });
    await runtime.close();
  });

  it("openSession input/stream/list/get/delete use info not user", async () => {
    const runtime = new Runtime({
      onModelCall: async () => "pong",
      sessions: memorySessions(),
    });
    setDefaultRuntime(runtime);
    try {
      const agent = Agent({ id: "bot", name: "Bot" }).build();
      const session = openSession(agent, { info: { tenant: "acme" } });
      expect(session.id).toBeTruthy();
      const accepted = await session.input("hi");
      expect(accepted.status).toBe("accepted");

      const events: string[] = [];
      const reader = (async () => {
        for await (const event of session.stream()) {
          events.push(event.type);
          if (event.type === "turn.settled") break;
        }
      })();
      await reader;
      expect(events).toContain("turn.started");
      expect(events).toContain("turn.settled");

      expect(await listSessions("bot")).toMatchObject([
        { session: session.id, status: "completed" },
      ]);
      expect((await getSession("bot", session.id))?.id).toBe(session.id);
      expect(await deleteSession("bot", session.id)).toBe(true);
      expect(await getSession("bot", session.id)).toBeUndefined();
    } finally {
      setDefaultRuntime(undefined);
      await runtime.close();
    }
  });

  it("serveAgents without runtime returns { fetch }; with runtime keeps Hono compat", async () => {
    const agent = Agent({ id: "a", name: "A" }).build();
    const runtime = new Runtime({
      onModelCall: async () => "ok",
      sessions: memorySessions(),
    });
    const hono = serveAgents({ agents: [agent], runtime });
    expect(typeof hono.request).toBe("function");
    const text = await (
      await hono.request("http://local/a/v1/ag-ui", {
        method: "POST",
        body: JSON.stringify({
          threadId: "t1",
          messages: [{ role: "user", content: "hi" }],
        }),
      })
    ).text();
    expect(text).toContain("RUN_FINISHED");
    await runtime.close();

    const shaped = serveAgents({
      agents: [
        Agent({ id: "b", name: "B" }).build(),
      ],
    });
    expect(shaped).toHaveProperty("fetch");
    expect(typeof shaped.fetch).toBe("function");
  });

  it("emits tool.progress into session events when tools call ctx.progress", async () => {
    const progress = vi.fn();
    const agent = Agent({ id: "p", name: "P" })
      .use({
        id: "t",
        tools: [
          tool({
            name: "work",
            input: z.object({}),
            async run(_args, ctx) {
              ctx.progress("halfway", { pct: 50 });
              return "done";
            },
          }),
        ],
      })
      .build();
    const host = new SessionHost(memorySessions());
    let calls = 0;
    await host.submit(agent, "s", "go", {
      onModelCall: async () => {
        calls += 1;
        if (calls === 1)
          return {
            output: [{ type: "tool-call", id: "1", name: "work", args: {} }],
          };
        return "ok";
      },
      onEvent: (event) => {
        if (event.type === "tool.progress") progress(event.payload);
      },
    });
    expect(progress).toHaveBeenCalled();
    expect(progress.mock.calls[0]![0]).toMatchObject({
      type: "tool.progress",
      attributes: { message: "halfway", data: { pct: 50 } },
    });
    await host.close();
  });

  it("resolves H6 ask waits via wait-resolve input", async () => {
    const agent = Agent({ id: "w", name: "W" })
      .use({
        id: "t",
        tools: [
          tool({
            name: "confirm",
            input: z.object({}),
            async run(_args, ctx) {
              const answer = await ctx.ask("Confirm?");
              return { answer };
            },
          }),
        ],
      })
      .build();
    const host = new SessionHost(memorySessions());
    let calls = 0;
    const first = await host.submit(agent, "s", "go", {
      onModelCall: async () => {
        calls += 1;
        if (calls === 1)
          return {
            output: [
              { type: "tool-call", id: "1", name: "confirm", args: {} },
            ],
          };
        return "done";
      },
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("expected pause");
    const waitId = first.pending[0]!.wait!.waitId;
    const second = await host.submit(
      agent,
      "s",
      { kind: "wait-resolve", waitId, value: "yes" },
      {
        onModelCall: async () => "done",
      },
    );
    expect(second.status).toBe("completed");
    expect(JSON.stringify(second.state)).toContain("yes");
    await host.close();
  });
});
