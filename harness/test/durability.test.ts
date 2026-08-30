import { describe, expect, it, vi } from "vitest";
import { Agent, HarnessError, type SessionRecord } from "../src/index.js";
import { model, offer, tool, toolCalls } from "./fixtures.js";

describe("structural seeds and recording", () => {
  it("accepts incomplete, unrelated, duplicated, and out-of-order typed tool history", async () => {
    const seen: unknown[] = [];
    const observed: string[] = [];
    const agent = Agent(
      model(async (call) => {
        seen.push(call.prompt);
        return "continued";
      }),
    ).build();
    const transcript = [
      {
        kind: "candidate" as const,
        turnId: "old-turn",
        stepId: "old-step",
        candidate: {
          output: [
            { type: "tool-call" as const, id: "a", name: "a", args: {} },
            { type: "tool-call" as const, id: "b", name: "b", args: {} },
            { type: "tool-call" as const, id: "c", name: "c", args: {} },
          ],
        },
      },
      {
        kind: "tool-results" as const,
        turnId: "other-turn",
        stepId: "other-step",
        results: [
          { callId: "b", toolName: "b", kind: "completed" as const, output: 2 },
          { callId: "a", toolName: "a", kind: "completed" as const, output: 1 },
          { callId: "a", toolName: "a", kind: "completed" as const, output: 1 },
          { callId: "unrelated", toolName: "other", kind: "denied" as const, reason: "no" },
        ],
      },
    ];
    const session = agent.run({ seed: { id: "seeded", transcript } });
    session.observe((event) => observed.push(event.type));
    expect(session.state.transcript).toEqual(transcript);
    expect((await session.continue().completed).status).toBe("completed");
    expect(session.state.transcript.filter((entry) => entry.kind === "input")).toHaveLength(0);
    expect(seen).toHaveLength(1);
    expect(observed).toContain("session.seeded");
    expect(observed).toContain("session.continued");
  });

  it("defensively copies seeds and rejects malformed typed JSON", () => {
    const transcript = [
      {
        kind: "input" as const,
        turnId: "turn",
        event: { kind: "user-message" as const, text: "before" },
      },
    ];
    const agent = Agent(model(async () => "done")).build();
    const session = agent.run({ seed: { transcript } });
    transcript[0]!.event.text = "after";
    expect(session.state.transcript[0]).toMatchObject({ event: { text: "before" } });
    expect(() =>
      agent.run({
        seed: {
          transcript: [{ kind: "tool-results", turnId: "t", stepId: "s", results: [{}] }],
        } as never,
      }),
    ).toThrowError(HarnessError);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      agent.run({
        seed: {
          transcript: [
            {
              kind: "input",
              turnId: "turn",
              event: { kind: "user-message", text: "bad", metadata: cyclic },
            },
          ],
        } as never,
      }),
    ).toThrowError(HarnessError);
    expect(() => agent.run({ seed: { transcript: [] }, id: "conflict" } as never)).toThrowError(
      expect.objectContaining({ code: "session.invalid-seed" }),
    );
  });

  it("records every effect barrier with monotonic revisions", async () => {
    const records: SessionRecord[] = [];
    const order: string[] = [];
    let step = 0;
    const agent = Agent(
      model(async () => {
        order.push("model");
        return ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
      }),
    )
      .use(
        "tools",
        offer(
          tool("echo", async () => {
            order.push("tool");
            return { kind: "completed", output: "ok" };
          }),
        ),
      )
      .build();
    const session = agent.run({
      recorder: {
        async record(value) {
          records.push(value);
          order.push(`record:${value.transition}`);
        },
      },
    });
    session.observe((event) => order.push(`observe:${event.type}`));

    expect((await session.input("go").completed).status).toBe("completed");
    expect(records.map((record) => record.transition)).toEqual([
      "input",
      "model-requested",
      "candidate",
      "tool-results",
      "model-requested",
      "candidate",
      "final",
    ]);
    expect(records.map((record) => record.revision)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(order.indexOf("record:model-requested")).toBeLessThan(order.indexOf("model"));
    expect(order.indexOf("record:candidate")).toBeLessThan(order.indexOf("tool"));
    expect(order.indexOf("record:tool-results")).toBeLessThan(
      order.indexOf("observe:tool.completed"),
    );
    expect(JSON.parse(JSON.stringify(records.at(-1)))).toEqual(records.at(-1));
    expect(Object.isFrozen(records.at(-1))).toBe(true);
  });

  it("continues recording from a seed revision", async () => {
    const records: SessionRecord[] = [];
    const session = Agent(model(async () => "done"))
      .build()
      .run({
        seed: { id: "session", revision: 7, transcript: [] },
        recorder: {
          async record(value) {
            records.push(value);
          },
        },
      });
    await session.continue().completed;
    expect(records[0]).toMatchObject({ revision: 8, transition: "model-requested" });
    expect(session.state.revision).toBe(10);
  });

  it("leaves provider-history rejection to the model adapter before network invocation", async () => {
    const network = vi.fn(async () => "unexpected");
    const session = Agent(
      model(async (call) => {
        const calls = call.prompt.flatMap((item) =>
          item.kind === "message" && item.role === "assistant"
            ? item.content.filter((part) => part.type === "tool-call")
            : [],
        );
        const results = call.prompt.filter((item) => item.kind === "tool-result");
        if (calls.length !== results.length)
          throw new Error("Provider projection rejected transcript entry 0");
        return network();
      }),
    )
      .build()
      .run({
        seed: {
          transcript: [
            {
              kind: "candidate",
              turnId: "old-turn",
              stepId: "old-step",
              candidate: {
                output: [{ type: "tool-call", id: "missing", name: "echo", args: {} }],
              },
            },
          ],
        },
      });

    const completion = await session.continue().completed;
    expect(network).not.toHaveBeenCalled();
    expect(completion.events).toContainEqual(
      expect.objectContaining({
        type: "tripwire",
        tripwire: expect.objectContaining({
          code: "model.failed",
          message: "Provider projection rejected transcript entry 0",
        }),
      }),
    );
  });

  it("fences model execution when recording fails", async () => {
    const invoke = vi.fn(async () => "done");
    const failure = new Error("database unavailable");
    const session = Agent(model(invoke))
      .build()
      .run({
        recorder: {
          async record() {
            throw failure;
          },
        },
      });
    await expect(session.input("go").completed).rejects.toMatchObject({
      code: "session.record-failed",
      cause: failure,
    });
    expect(invoke).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({ status: "stopped", revision: 0 });
  });

  it("preserves the last good revision and prevents tools and queued work after failure", async () => {
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "no" }));
    const failure = new Error("candidate write failed");
    const session = Agent(model(async () => toolCalls({ id: "call", name: "echo", args: {} })))
      .use("tools", offer(tool("echo", execute)))
      .build()
      .run({
        recorder: {
          async record(value) {
            if (value.transition === "candidate") throw failure;
          },
        },
      });

    const active = session.input("one");
    const queued = session.input("two");
    await expect(active.completed).rejects.toMatchObject({
      code: "session.record-failed",
      cause: failure,
    });
    await expect(queued.completed).resolves.toMatchObject({ status: "stopped" });
    expect(execute).not.toHaveBeenCalled();
    expect(session.state).toMatchObject({ status: "stopped", revision: 2 });
    expect(session.state.transcript.some((entry) => entry.kind === "candidate")).toBe(false);
  });

  it("records deferred tool handoff without committing partial results", async () => {
    const records: SessionRecord[] = [];
    let step = 0;
    const session = Agent(
      model(async () =>
        ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "unexpected",
      ),
    )
      .use(
        "tools",
        offer(tool("echo", async () => ({ kind: "deferred", token: { jobId: "job" } }))),
      )
      .build()
      .run({
        recorder: {
          async record(value) {
            records.push(value);
          },
        },
      });

    expect((await session.input("go").completed).status).toBe("waiting");
    expect(session.state.status).toBe("waiting");
    expect(session.state.transcript.some((entry) => entry.kind === "tool-results")).toBe(false);
    expect(records.at(-1)).toMatchObject({
      transition: "waiting",
      active: {
        kind: "tools",
        calls: [{ callId: "call", status: "deferred", token: { jobId: "job" } }],
      },
    });
    expect(JSON.parse(JSON.stringify(records.at(-1)))).toEqual(records.at(-1));

    const queued = session.input("do not run");
    await Promise.resolve();
    expect(session.state.status).toBe("waiting");
    await session.stop();
    await expect(queued.completed).resolves.toMatchObject({ status: "stopped" });
  });

  it("records model deferral before publishing waiting", async () => {
    const records: SessionRecord[] = [];
    const observed: string[] = [];
    let invocationId: string | undefined;
    const session = Agent(
      model(async (_call, context) => {
        invocationId = context.invocationId;
        return { kind: "deferred", token: { requestId: "request" } };
      }),
    )
      .build()
      .run({
        recorder: {
          async record(value) {
            records.push(value);
          },
        },
      });
    session.observe((event) => observed.push(event.type));

    expect((await session.continue().completed).status).toBe("waiting");
    expect(records.at(-1)).toMatchObject({
      transition: "waiting",
      active: { kind: "model", invocationId, token: { requestId: "request" } },
    });
    expect(observed.indexOf("model.deferred")).toBeGreaterThanOrEqual(0);
  });

  it("rejects explicit stop when its stopped record fails", async () => {
    const cause = new Error("write failed");
    const session = Agent(model(async () => "done"))
      .build()
      .run({
        recorder: {
          async record() {
            throw cause;
          },
        },
      });

    await expect(session.stop()).rejects.toMatchObject({
      code: "session.record-failed",
      cause,
    });
    expect(session.state).toMatchObject({ status: "stopped", revision: 0 });
  });
});
