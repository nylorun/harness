import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { tool } from "../src/index.js";
import { testAgent, model, toolCalls } from "./fixtures.js";

const schema = z.object({});

describe("capability declarations", () => {
  it("contributes static surface and can route dynamically from its inline middleware", async () => {
    const seen: unknown[] = [];
    const contributors: Array<{ readonly middlewareId: string; readonly slot: string }> = [];
    const agent = testAgent()
      .use({
        id: "routing",
        instructions: ["Use the declared route."],
        middleware: async (request, next) => {
          request.configuration.model.select({ id: request.turnNumber === 1 ? "fast" : "deep" });
          return next();
        },
      })
      .with(
        model(async (call) => {
          seen.push(call.model);
          return "done";
        }),
      )
      .build();

    const session = agent.run();
    session.observe((event) => {
      if (event.type === "model.requested")
        contributors.push(...event.attributes.configuration.contributors);
    });
    await session.input("one").completed;
    await session.input("two").completed;
    expect(seen).toEqual([{ id: "fast" }, { id: "deep" }]);
    expect(contributors).toContainEqual(
      expect.objectContaining({ middlewareId: "routing", slot: "routing" }),
    );
    await session.stop();
  });

  it("shares one typed state across declaration middleware and concurrent tools", async () => {
    const created: string[] = [];
    const disposed: number[] = [];
    const contexts: Array<Record<string, string>> = [];
    const toolOwners: unknown[] = [];
    const increment = tool<typeof schema, { readonly id: string; count: number }>({
      name: "increment",
      parameters: schema,
      async execute(_args, context) {
        const state = await context.state;
        state.count += 1;
        contexts.push({
          sessionId: context.sessionId,
          turnId: context.turnId,
          stepId: context.stepId,
          callId: context.callId,
          invocationId: context.invocationId,
        });
        return { kind: "completed", output: state.count };
      },
    });
    let step = 0;
    const agent = testAgent()
      .use({
        id: "counter",
        state: {
          create: (session) => {
            created.push(session.id);
            return { id: session.id, count: 0 };
          },
          dispose: (state) => disposed.push(state.count),
        },
        tools: { slot: "counter-tools", items: [increment] },
        middleware: async (request, next) => {
          const state = await request.state;
          state.count += 1;
          return next();
        },
      })
      .with(
        model(async () =>
          ++step === 1
            ? toolCalls(
                { id: "first", name: "increment", args: {} },
                { id: "second", name: "increment", args: {} },
              )
            : "done",
        ),
      )
      .build();

    const session = agent.run({ id: "counter-session" });
    session.observe((event) => {
      if (event.type === "model.requested")
        toolOwners.push(...event.attributes.configuration.tools);
    });
    await session.input("go").completed;
    expect(created).toEqual(["counter-session"]);
    expect(contexts).toHaveLength(2);
    expect(contexts.map((context) => context.sessionId)).toEqual([
      "counter-session",
      "counter-session",
    ]);
    expect(new Set(contexts.map((context) => context.turnId))).toHaveLength(1);
    expect(new Set(contexts.map((context) => context.stepId))).toHaveLength(1);
    expect(new Set(contexts.map((context) => context.callId))).toEqual(
      new Set(["first", "second"]),
    );
    expect(contexts.every((context) => context.invocationId.length > 0)).toBe(true);
    expect(toolOwners).toContainEqual(
      expect.objectContaining({
        name: "increment",
        owner: { middlewareId: "counter", slot: "counter-tools" },
      }),
    );
    await session.stop();
    expect(disposed).toEqual([4]);
  });

  it("turns state creation failure into a Step tripwire without partial disposal", async () => {
    const dispose = vi.fn();
    const agent = testAgent()
      .use({
        id: "broken",
        state: {
          create: () => {
            throw new Error("no workspace");
          },
          dispose,
        },
        middleware: async (request, next) => {
          await request.state;
          return next();
        },
      })
      .with(model(async () => "unreachable"))
      .build();

    const session = agent.run();
    await expect(session.input("go").completed).resolves.toMatchObject({
      events: [
        { type: "input" },
        { type: "tripwire", tripwire: { code: "capability.state.create-failed" } },
      ],
    });
    await session.stop();
    expect(dispose).not.toHaveBeenCalled();
  });

  it("aborts and disposes an in-flight factory before stop resolves", async () => {
    let started = false;
    let observedAbort = false;
    const dispose = vi.fn();
    const agent = testAgent()
      .use({
        id: "slow",
        state: {
          create: (_session, signal) =>
            new Promise<{ readonly value: string }>((resolve) => {
              started = true;
              signal.addEventListener("abort", () => {
                observedAbort = true;
                resolve({ value: "late" });
              });
            }),
          dispose,
        },
        middleware: async (request, next) => {
          await request.state;
          return next();
        },
      })
      .with(model(async () => "unreachable"))
      .build();

    const session = agent.run();
    const pending = session.input("go").completed;
    await vi.waitFor(() => expect(started).toBe(true));
    await session.stop();
    await expect(pending).resolves.toMatchObject({ status: "stopped" });
    expect(observedAbort).toBe(true);
    expect(dispose).toHaveBeenCalledWith({ value: "late" });
  });

  it("recreates state for a cold seed instead of restoring prior in-memory values", async () => {
    const created: string[] = [];
    const agent = testAgent()
      .use({
        id: "cache",
        state: {
          create: (session) => {
            created.push(session.id);
            return { sessionId: session.id };
          },
        },
        middleware: async (request, next) => {
          await request.state;
          return next();
        },
      })
      .with(model(async () => "done"))
      .build();

    const initial = agent.run({ id: "original" });
    await initial.input("go").completed;
    const { id, revision, turnCount, transcript } = initial.state;
    const seed = { id, revision, turnCount, transcript };
    await initial.stop();

    const resumed = agent.run({ seed });
    await resumed.continue().completed;
    await resumed.stop();
    expect(created).toEqual(["original", "original"]);
  });

  it("disposes created state after a recorder failure and reports disposal failures live", async () => {
    const dispose = vi.fn(() => {
      throw new Error("cleanup failed");
    });
    const observed: string[] = [];
    const agent = testAgent()
      .use({
        id: "recorded-state",
        state: { create: () => ({ opened: true }), dispose },
        middleware: async (request, next) => {
          await request.state;
          return next();
        },
      })
      .with(model(async () => "unreachable"))
      .build();

    const session = agent.run({
      recorder: {
        async record(record) {
          if (record.transition === "model-requested") throw new Error("storage unavailable");
        },
      },
    });
    session.observe((event) => observed.push(event.type));
    await expect(session.input("go").completed).rejects.toMatchObject({
      code: "session.record-failed",
    });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledWith({ opened: true }));
    expect(observed).toContain("capability.state.dispose.failed");
  });
});
