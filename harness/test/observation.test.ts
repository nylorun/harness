import { describe, expect, it } from "vitest";
import { Agent, type ObserveEvent } from "../src/index.js";
import { adapter, model, offer, tool, toolCalls } from "./fixtures.js";

function expectPlainJson(value: unknown): void {
  const encoded = JSON.stringify(value);
  expect(encoded).toBeDefined();
  expect(JSON.parse(encoded!)).toEqual(value);
}

describe("observation", () => {
  it("is causal within a run and fail-open for sync and async observer failures", async () => {
    const types: string[] = [];
    const healthy: string[] = [];
    let count = 0;
    const result = Agent(model(async () => "done")).build();
    const session = result.run();
    session.observe((event) => {
      types.push(event.type);
      count += 1;
      if (count % 2) throw new Error("sync observer failure");
      return Promise.reject(new Error("async observer failure"));
    });
    session.observe((event) => healthy.push(event.type));
    const completion = await session.input("go").completed;
    expect(completion.status).toBe("completed");
    expect(types.indexOf("model.requested")).toBeLessThan(types.indexOf("model.completed"));
    expect(healthy).toEqual(types);
  });

  it("delivers events to independent observers and unsubscribes one idempotently", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const session = Agent(model(async () => "done"))
      .build()
      .run();
    const unsubscribeFirst = session.observe((event) => first.push(event.type));
    session.observe((event) => second.push(event.type));

    await session.input("first").completed;
    expect(first).toEqual(second);
    expect(first).toContain("turn.completed");

    unsubscribeFirst();
    unsubscribeFirst();
    const firstCount = first.length;
    await session.input("second").completed;
    expect(first).toHaveLength(firstCount);
    expect(second.length).toBeGreaterThan(firstCount);
  });

  it("deduplicates listeners and applies subscription changes from the next event", async () => {
    const duplicateTypes: string[] = [];
    const earlyTypes: string[] = [];
    const lateTypes: string[] = [];
    const session = Agent(model(async () => "done"))
      .build()
      .run();
    const duplicate = (event: ObserveEvent) => duplicateTypes.push(event.type);
    session.observe(duplicate);
    session.observe(duplicate);

    let unsubscribeEarly!: () => void;
    unsubscribeEarly = session.observe((event) => {
      earlyTypes.push(event.type);
      if (event.type === "input.received") {
        session.observe((nextEvent) => lateTypes.push(nextEvent.type));
        unsubscribeEarly();
      }
    });

    await session.input("go").completed;
    expect(duplicateTypes.filter((type) => type === "input.received")).toHaveLength(1);
    expect(earlyTypes).toEqual(["input.received"]);
    expect(lateTypes).not.toContain("input.received");
    expect(lateTypes).toContain("step.started");
  });

  it("records requestedModelId only when middleware selected an id", async () => {
    const selected: unknown[] = [];
    const routed = Agent(model(async () => "done"))
      .use("route", async (request, next) => {
        request.configuration.model.select({ id: "test-model" });
        return next();
      })
      .build();
    const routedSession = routed.run();
    routedSession.observe((event) => {
      if (event.type === "model.requested" || event.type === "model.completed")
        selected.push(event.requestedModelId);
    });
    await routedSession.input("go").completed;
    expect(selected).toEqual(["test-model", "test-model"]);
    await routedSession.stop();

    const omitted: unknown[] = [];
    const plain = Agent(model(async () => "done")).build();
    const plainSession = plain.run();
    plainSession.observe((event) => {
      if (event.type === "model.requested" || event.type === "model.completed")
        omitted.push(event.requestedModelId);
    });
    await plainSession.input("go").completed;
    expect(omitted).toEqual([undefined, undefined]);
    await plainSession.stop();
  });

  it("projects the model.requested prefix to plain JSON", async () => {
    const observed: ObserveEvent[] = [];
    const session = Agent(model(async () => "done"))
      .with(adapter())
      .use("tools", offer(tool()))
      .build()
      .run();
    session.observe((event) => observed.push(event));

    await session.input("go").completed;

    const started = observed.find((event) => event.type === "model.requested");
    if (!started || started.type !== "model.requested") throw new Error("missing model.requested");
    expectPlainJson(started.attributes);
  });

  it("publishes input.cancelled on observe when a queued input is aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = Agent(
      model(async () => {
        await gate;
        return "done";
      }),
    )
      .build()
      .run();
    const observed: ObserveEvent[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    session.observe((event) => {
      observed.push(event);
      if (event.type === "model.requested") markStarted();
    });
    const first = session.input("first");
    await started;
    const controller = new AbortController();
    const queued = session.input("second", { signal: controller.signal });
    controller.abort(new Error("drop queued"));
    release();
    expect((await first.completed).status).toBe("completed");
    expect((await queued.completed).status).toBe("cancelled");
    expect(observed).toContainEqual({
      type: "input.cancelled",
      inputId: queued.inputId,
      reason: "drop queued",
    });
  });

  it("publishes input.cancelled on observe when the active input is aborted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const session = Agent(
      model(async () => {
        await gate;
        return "done";
      }),
    )
      .build()
      .run();
    const observed: ObserveEvent[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    session.observe((event) => {
      observed.push(event);
      if (event.type === "model.requested") markStarted();
    });
    const controller = new AbortController();
    const handle = session.input("go", { signal: controller.signal });
    await started;
    controller.abort(new Error("stop the turn"));
    release();
    expect((await handle.completed).status).toBe("cancelled");
    expect(observed.some((event) => event.type === "turn.completed")).toBe(false);
    expect(observed).toContainEqual({
      type: "input.cancelled",
      inputId: handle.inputId,
      reason: "stop the turn",
    });
  });

  it("closes a thrown adapter with adapter.completed failed and continues the turn", async () => {
    let step = 0;
    const session = Agent(
      model(async () =>
        ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
      ),
    )
      .with(
        adapter(async () => {
          throw new Error("boom");
        }),
      )
      .use("test", offer(tool()))
      .build()
      .run();
    const observed: ObserveEvent[] = [];
    session.observe((event) => observed.push(event));
    expect((await session.input("go").completed).status).toBe("completed");
    const types = observed.map((event) => event.type);
    const started = types.indexOf("adapter.started");
    const completed = types.indexOf("adapter.completed");
    expect(started).toBeGreaterThan(-1);
    expect(completed).toBeGreaterThan(started);
    expect(observed[completed]).toMatchObject({
      type: "adapter.completed",
      toolName: "echo",
      callId: "call",
      outcome: "failed",
      code: "tool.execution-failed",
      attributes: { kind: "failed", message: "boom" },
    });
    expect(types.includes("tripwire")).toBe(false);
    expect(types.indexOf("turn.completed")).toBeGreaterThan(completed);
    expect(types.indexOf("model.requested", completed)).toBeGreaterThan(completed);
  });

  it("stamps the active inputId on turn-scoped observe events across a queued second input", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const session = Agent(
      model(async () => {
        calls += 1;
        if (calls === 1) await gate;
        return `turn-${calls}`;
      }),
    )
      .build()
      .run();
    const observed: ObserveEvent[] = [];
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    session.observe((event) => {
      observed.push(event);
      if (event.type === "model.requested") markStarted();
    });
    const first = session.input("first");
    await started;
    const second = session.input("second");
    release();
    await first.completed;
    await second.completed;

    const firstScoped = observed.filter(
      (event) => "turnId" in event && event.inputId === first.inputId,
    );
    const secondScoped = observed.filter(
      (event) => "turnId" in event && event.inputId === second.inputId,
    );
    const firstDone = firstScoped.find((event) => event.type === "turn.completed");
    const secondDone = secondScoped.find((event) => event.type === "turn.completed");
    expect(firstDone?.turnId).toBeDefined();
    expect(secondDone?.turnId).toBeDefined();
    expect(firstDone?.turnId).not.toBe(secondDone?.turnId);
    expect(firstScoped.every((event) => event.turnId === firstDone?.turnId)).toBe(true);
    expect(secondScoped.every((event) => event.turnId === secondDone?.turnId)).toBe(true);
  });

  it("stamps the approve inputId on resume events of the same turn", async () => {
    let step = 0;
    const session = Agent(
      model(async () =>
        ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
      ),
    )
      .with(adapter())
      .use("approve-echo", async (_request, next) => {
        const response = await next();
        const call = response.toolCalls()[0];
        if (call) response.requireInteraction(call.id, { kind: "approval", prompt: "Run echo?" });
        return response;
      })
      .use("test", offer(tool()))
      .build()
      .run();
    const observed: ObserveEvent[] = [];
    session.observe((event) => observed.push(event));
    const first = session.input("Echo hello");
    const waiting = await first.completed;
    const required = waiting.events.find((event) => event.type === "interaction.required");
    if (!required || required.type !== "interaction.required")
      throw new Error("missing interaction");
    const pause = observed.find((event) => event.type === "interaction.required");
    expect(pause?.inputId).toBe(first.inputId);
    expect(pause).toMatchObject({
      type: "interaction.required",
      callId: "call",
      phase: "interaction",
      attributes: { prompt: "Run echo?" },
    });
    const approve = session.input({
      kind: "approve",
      interactionId: required.interaction.id,
      approved: true,
    });
    await approve.completed;
    const approveIndex = observed.findIndex(
      (event) => event.type === "input.received" && event.kind === "approve",
    );
    const afterApprove = observed
      .slice(approveIndex + 1)
      .filter((event) => "turnId" in event && event.inputId === approve.inputId);
    expect(afterApprove.some((event) => event.type === "adapter.started")).toBe(true);
    expect(afterApprove.some((event) => event.type === "turn.completed")).toBe(true);
    expect(afterApprove.every((event) => event.turnId === pause?.turnId)).toBe(true);
  });

  it("copies raw emit-site snapshots onto filterable observe events", async () => {
    let step = 0;
    const session = Agent(
      model(async () =>
        ++step === 1
          ? toolCalls({ id: "call_1", name: "echo", args: { text: "hello" } })
          : "Completed with echoed",
      ),
    )
      .with(
        adapter(async (call) => ({ kind: "completed" as const, output: { echoed: call.args } })),
      )
      .use("echo", async (request, next) => {
        request.configuration.tools.set("capture", [tool()]);
        request.configuration.instructions.set("capture", ["Echo the user text."]);
        return next();
      })
      .build()
      .run();
    const observed: ObserveEvent[] = [];
    session.observe((event) => observed.push(event));
    const handle = session.input("Echo hello");
    expect((await handle.completed).status).toBe("completed");

    const received = observed.find((event) => event.type === "input.received");
    expect(received).toMatchObject({
      type: "input.received",
      inputId: handle.inputId,
      kind: "user-message",
    });
    const entered = observed.find((event) => event.type === "middleware.entered");
    expect(entered).toMatchObject({ type: "middleware.entered", middlewareId: "echo" });

    const steps = observed.filter((event) => event.type === "step.started");
    expect(steps).toHaveLength(2);
    const firstStep = steps[0];
    const secondStep = steps[1];
    if (!firstStep || firstStep.type !== "step.started") throw new Error("missing first step");
    if (!secondStep || secondStep.type !== "step.started") throw new Error("missing second step");
    expect(firstStep).toMatchObject({ type: "step.started", turnNumber: 1, stepNumber: 1 });
    expect(firstStep.attributes.arrivals[0]).toMatchObject({
      kind: "user-message",
      text: "Echo hello",
    });
    expect(secondStep.turnNumber).toBe(1);
    expect(secondStep.stepNumber).toBe(2);
    expect(secondStep.attributes.arrivals).toEqual([]);
    expect(secondStep.attributes.toolResults).toEqual([
      expect.objectContaining({ callId: "call_1", toolName: "echo", kind: "completed" }),
    ]);
    expect(observed.indexOf(firstStep)).toBeLessThan(observed.indexOf(entered!));

    const started = observed.find((event) => event.type === "model.requested");
    if (!started || started.type !== "model.requested") throw new Error("missing model.requested");
    expect(started.attributes.configuration.instructions.map((item) => item.text)).toContain(
      "Echo the user text.",
    );
    expect(started.attributes.call.tools.map((item) => item.name)).toEqual(["echo"]);

    const completed = observed.find((event) => event.type === "model.completed");
    if (!completed || completed.type !== "model.completed")
      throw new Error("missing model.completed");
    expect(completed.attributes.output).toEqual([
      expect.objectContaining({ type: "tool-call", name: "echo", args: { text: "hello" } }),
    ]);

    const sealed = observed.find((event) => event.type === "tool.sealed");
    if (!sealed || sealed.type !== "tool.sealed") throw new Error("missing tool.sealed");
    expect(sealed.attributes.executable).toEqual([
      expect.objectContaining({ callId: "call_1", toolName: "echo", args: { text: "hello" } }),
    ]);

    const adapterDone = observed.find((event) => event.type === "adapter.completed");
    expect(adapterDone).toMatchObject({
      type: "adapter.completed",
      toolName: "echo",
      callId: "call_1",
      outcome: "completed",
      attributes: { kind: "completed", output: { echoed: { text: "hello" } } },
    });

    const turn = observed.find((event) => event.type === "turn.completed");
    if (!turn || turn.type !== "turn.completed") throw new Error("missing turn.completed");
    expect(turn.attributes.output).toBe("Completed with echoed");
  });

  it("emits step.started before an early middleware tripwire and skips model.requested", async () => {
    const session = Agent(model(async () => "done"))
      .use("block", async (request) => request.tripwire({ code: "policy.block", message: "nope" }))
      .build()
      .run();
    const observed: ObserveEvent[] = [];
    session.observe((event) => observed.push(event));
    await session.input("go").completed;
    const started = observed.find((event) => event.type === "step.started");
    expect(started).toMatchObject({
      type: "step.started",
      turnNumber: 1,
      stepNumber: 1,
      attributes: {
        arrivals: [expect.objectContaining({ kind: "user-message", text: "go" })],
      },
    });
    expect(observed.some((event) => event.type === "model.requested")).toBe(false);
    expect(observed.some((event) => event.type === "tripwire")).toBe(true);
  });

  it("puts tripwire code on the event and the message in attributes", async () => {
    const session = Agent(
      model(async () => {
        throw new Error("provider down");
      }),
    )
      .build()
      .run();
    const observed: ObserveEvent[] = [];
    session.observe((event) => observed.push(event));
    await session.input("go").completed;
    const trip = observed.find((event) => event.type === "tripwire");
    expect(trip).toMatchObject({
      type: "tripwire",
      code: "model.failed",
      scope: "step",
      attributes: { message: "provider down" },
    });
  });

  it("publishes the exact immutable ModelCall supplied to the adapter", async () => {
    let step = 0;
    const calls: unknown[] = [];
    const session = Agent(
      model(async (call) => {
        calls.push(call);
        return ++step === 1
          ? toolCalls({ id: "call", name: "echo", args: { text: "hi" } })
          : "done";
      }),
    )
      .with(adapter())
      .use("echo", offer(tool()))
      .build()
      .run();
    const observed: ObserveEvent[] = [];
    session.observe((event) => observed.push(event));
    expect((await session.input("go").completed).status).toBe("completed");

    const firstStep = observed.find((event) => event.type === "step.started");
    const firstStarted = observed.find((event) => event.type === "model.requested");
    if (!firstStep || firstStep.type !== "step.started") throw new Error("missing step.started");
    if (!firstStarted || firstStarted.type !== "model.requested")
      throw new Error("missing model.requested");

    expect(Object.isFrozen(firstStep.attributes.transcript)).toBe(true);
    expect(firstStarted.attributes.call).toBe(calls[0]);
    expect(Object.isFrozen(firstStarted.attributes.call)).toBe(true);
    expectPlainJson(firstStep.attributes.transcript);
    expectPlainJson(firstStarted.attributes.call);

    const firstLength = firstStep.attributes.transcript.length;
    expect(session.state.transcript.length).toBeGreaterThan(firstLength);
    expect(firstStep.attributes.transcript).toHaveLength(firstLength);
    expect(() => {
      (firstStarted.attributes.call.prompt as { kind: string }[]).push({ kind: "forged" });
    }).toThrow();
  });
});
