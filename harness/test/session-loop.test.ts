import { describe, expect, it } from "vitest";
import { testAgent, execution, offer, model, tool, toolCalls, turn } from "./fixtures.js";

describe("Session loop", () => {
  it("submits eagerly and processes overlapping inputs FIFO", async () => {
    const seen: string[] = [];
    const result = testAgent()
      .with(
        model(async (_call, { request }) => {
          const arrival = request.arrivals[0];
          const text =
            arrival?.kind === "user-message" || arrival?.kind === "interrupt" ? arrival.text : "";
          await new Promise((resolve) => setTimeout(resolve, text === "one" ? 20 : 0));
          seen.push(text);
          return text;
        }),
      )
      .build();
    const { session, handle: one } = turn(result, "one");
    const two = session.input("two");
    const three = session.interrupt("three");
    expect(
      (await Promise.all([one.completed, two.completed, three.completed])).map(
        (item) => item.status,
      ),
    ).toEqual(["completed", "completed", "completed"]);
    expect(seen).toEqual(["one", "two", "three"]);
    expect(
      session.state.transcript.filter((item) => item.kind === "final").map((item) => item.output),
    ).toEqual(["one", "two", "three"]);
    expect(session.state.status).toBe("idle");
  });

  it("does not impose a native model-step ceiling", async () => {
    let modelCalls = 0;
    const result = testAgent()
      .use(
        "test",
        offer(
          tool(
            "echo",
            execution(async () => ({ kind: "completed", output: "ok" })),
          ),
        ),
      )
      .with(
        model(async () =>
          ++modelCalls <= 33
            ? toolCalls({ id: `call-${modelCalls}`, name: "echo", args: {} })
            : "done",
        ),
      )
      .build();

    const completion = await turn(result, "go").handle.completed;

    expect(completion.status).toBe("completed");
    expect(completion.events[0]).toMatchObject({
      type: "input",
      event: { kind: "user-message", text: "go" },
    });
    expect(completion.events.some((event) => event.type === "candidate")).toBe(true);
    expect(completion.events.at(-1)).toMatchObject({ type: "final", output: "done" });
    expect(modelCalls).toBe(34);
  });

  it("quarantines a late model result after stop", async () => {
    const result = testAgent()
      .with(
        model(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return "late";
        }),
      )
      .build();
    const { session, handle } = turn(result, "go");
    await session.stop();
    const completion = await handle.completed;
    expect(completion.status).toBe("stopped");
    expect(session.state.transcript.some((item) => item.kind === "final")).toBe(false);
  });

  it("pairs a cancelled sealed plan before processing the next queued Turn", async () => {
    let releaseAdapter!: () => void;
    let markAdapterStarted!: () => void;
    const adapterStarted = new Promise<void>((resolve) => {
      markAdapterStarted = resolve;
    });
    const adapterGate = new Promise<void>((resolve) => {
      releaseAdapter = resolve;
    });
    let modelStep = 0;
    const local = execution(async () => {
      markAdapterStarted();
      await adapterGate;
      return { kind: "completed", output: "late" };
    });
    const result = testAgent()
      .use("test", offer(tool("echo", local)))
      .with(
        model(async () =>
          ++modelStep === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "next",
        ),
      )
      .build();
    const controller = new AbortController();
    const { session, handle: active } = turn(result, "first", { signal: controller.signal });
    await adapterStarted;
    const queued = session.input("second");
    controller.abort(new Error("stop the tool"));
    releaseAdapter();

    expect((await active.completed).status).toBe("cancelled");
    expect((await queued.completed).status).toBe("completed");
    const transcript = session.state.transcript;
    const candidateIndex = transcript.findIndex((entry) => entry.kind === "candidate");
    const resultsIndex = transcript.findIndex((entry) => entry.kind === "tool-results");
    const secondInputIndex = transcript.findIndex(
      (entry) =>
        entry.kind === "input" &&
        entry.event.kind === "user-message" &&
        entry.event.text === "second",
    );
    expect(candidateIndex).toBeLessThan(resultsIndex);
    expect(resultsIndex).toBeLessThan(secondInputIndex);
    const results = transcript[resultsIndex];
    expect(results?.kind).toBe("tool-results");
    if (results?.kind === "tool-results")
      expect(results.results).toEqual([
        expect.objectContaining({ callId: "call", kind: "failed", code: "tool.cancelled" }),
      ]);
  });

  it("claims an interrupt onto the next step of the same turn", async () => {
    let releaseTool!: () => void;
    let markToolStarted!: () => void;
    const toolStarted = new Promise<void>((resolve) => {
      markToolStarted = resolve;
    });
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const arrivals: string[][] = [];
    let modelStep = 0;
    const result = testAgent()
      .use(
        "test",
        offer(
          tool(
            "echo",
            execution(async () => {
              markToolStarted();
              await toolGate;
              return { kind: "completed" as const, output: "ok" };
            }),
          ),
        ),
      )
      .with(
        model(async (_call, { request }) => {
          arrivals.push(
            request.arrivals.map((item) =>
              item.kind === "user-message" || item.kind === "interrupt" ? item.text : item.kind,
            ),
          );
          return ++modelStep === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();
    const { session, handle } = turn(result, "go");
    await toolStarted;
    const interrupt = session.interrupt("steer");
    releaseTool();
    const interruptDone = await interrupt.completed;
    expect(interruptDone.status).toBe("completed");
    expect(interruptDone.events.some((event) => event.type === "final")).toBe(false);
    expect(interruptDone.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "input",
          event: { kind: "interrupt", text: "steer" },
        }),
      ]),
    );
    const turnDone = await handle.completed;
    expect(turnDone.status).toBe("completed");
    expect(turnDone.events.at(-1)).toMatchObject({ type: "final", output: "done" });
    expect(arrivals).toEqual([["go"], ["steer"]]);
    expect(session.state.turnCount).toBe(1);
    expect(session.state.transcript.filter((entry) => entry.kind === "final")).toHaveLength(1);
    expect(
      session.state.transcript.some(
        (entry) =>
          entry.kind === "input" &&
          entry.event.kind === "interrupt" &&
          entry.event.text === "steer",
      ),
    ).toBe(true);
    await session.stop();
    const inputKinds: string[] = [];
    for await (const event of session.stream()) {
      if (event.type === "input") inputKinds.push(event.event.kind);
    }
    expect(inputKinds).toEqual(["user-message", "interrupt"]);
  });

  it("starts a new turn when interrupt arrives after the current turn has finalized", async () => {
    const result = testAgent()
      .with(
        model(async (_call, { request }) => {
          const arrival = request.arrivals[0];
          return arrival?.kind === "user-message" || arrival?.kind === "interrupt"
            ? arrival.text
            : "done";
        }),
      )
      .build();
    const { session, handle } = turn(result, "one");
    await handle.completed;
    const later = await session.interrupt("two").completed;
    expect(later.status).toBe("completed");
    expect(later.events.at(-1)).toMatchObject({ type: "final", output: "two" });
    expect(session.state.turnCount).toBe(2);
    expect(
      session.state.transcript
        .filter((entry) => entry.kind === "final")
        .map((entry) => entry.output),
    ).toEqual(["one", "two"]);
  });

  it("keeps an interrupt queued while waiting, then claims it on the next step after approve", async () => {
    const arrivals: string[][] = [];
    let modelStep = 0;
    const result = testAgent()
      .use("approval", async (_request, next) => {
        const response = await next();
        response.requireInteraction("call", { kind: "approval", prompt: "approve" });
        return response;
      })
      .use(
        "test",
        offer(
          tool(
            "echo",
            execution(async () => ({ kind: "completed" as const, output: "ok" })),
          ),
        ),
      )
      .with(
        model(async (_call, { request }) => {
          arrivals.push(
            request.arrivals.map((item) =>
              item.kind === "user-message" || item.kind === "interrupt" ? item.text : item.kind,
            ),
          );
          return ++modelStep === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();
    const { session, handle } = turn(result, "go");
    const first = await handle.completed;
    expect(first.status).toBe("waiting");
    const required = first.events.find((event) => event.type === "interaction.required");
    if (!required || required.type !== "interaction.required")
      throw new Error("missing interaction");
    const interrupt = session.interrupt("steer");
    expect(session.state.status).toBe("waiting");
    const resumed = session.input({
      kind: "approve",
      interactionId: required.interaction.id,
      approved: true,
    });
    expect((await interrupt.completed).status).toBe("completed");
    expect((await resumed.completed).status).toBe("completed");
    expect(arrivals).toEqual([["go"], ["steer"]]);
    expect(session.state.turnCount).toBe(1);
  });

  it("replays the Session conversation log from the start and is not input()", async () => {
    const result = testAgent()
      .with(model(async () => "hello"))
      .build();
    const session = result.run();
    const handle = session.input("go");
    expect(Symbol.asyncIterator in handle).toBe(false);
    await handle.completed;
    await session.stop();
    const first: string[] = [];
    for await (const event of session.stream()) first.push(event.type);
    const second: string[] = [];
    for await (const event of session.stream()) second.push(event.type);
    expect(first).toEqual(["input", "candidate", "final", "session.stopped"]);
    expect(second).toEqual(first);
  });
});
