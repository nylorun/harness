import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import { adapter, offer, model, tool, toolCalls, turn } from "./fixtures.js";

describe("Session loop", () => {
  it("submits eagerly and processes overlapping inputs FIFO", async () => {
    const seen: string[] = [];
    const result = Agent(
      model(async (request) => {
        const arrival = request.arrivals[0];
        const text =
          arrival?.kind === "user-message" || arrival?.kind === "interrupt" ? arrival.text : "";
        await new Promise((resolve) => setTimeout(resolve, text === "one" ? 20 : 0));
        seen.push(text);
        return text;
      }),
    ).build();
    const { session, handle: one } = turn(result, "one");
    const two = session.input({ kind: "user-message", text: "two" });
    const three = session.input({ kind: "interrupt", text: "three" });
    expect(
      (await Promise.all([one.consume(), two.consume(), three.consume()])).map(
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
    const result = Agent(
      model(async () =>
        ++modelCalls <= 33
          ? toolCalls({ id: `call-${modelCalls}`, name: "echo", args: {} })
          : "done",
      ),
    )
      .with(adapter(async () => ({ kind: "completed", output: "ok" })))
      .use("test", offer(tool()))
      .build();

    const completion = await turn(result, "go").handle.completed;

    expect(completion).toMatchObject({
      status: "completed",
      events: [expect.objectContaining({ type: "final", output: "done" })],
    });
    expect(modelCalls).toBe(34);
  });

  it("quarantines a late model result after stop", async () => {
    const result = Agent(
      model(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "late";
      }),
    ).build();
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
    const local = adapter(async () => {
      markAdapterStarted();
      await adapterGate;
      return { kind: "completed", output: "late" };
    });
    const result = Agent(
      model(async () =>
        ++modelStep === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "next",
      ),
    )
      .with(local)
      .use("test", offer(tool()))
      .build();
    const controller = new AbortController();
    const { session, handle: active } = turn(result, "first", { signal: controller.signal });
    await adapterStarted;
    const queued = session.input({ kind: "user-message", text: "second" });
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

  it("replays the Session conversation log from the start and is not input()", async () => {
    const result = Agent(model(async () => "hello")).build();
    const session = result.run();
    const handle = session.input("go");
    expect(Symbol.asyncIterator in handle).toBe(false);
    await handle.completed;
    await session.stop();
    const first: string[] = [];
    for await (const event of session.stream()) first.push(event.type);
    const second: string[] = [];
    for await (const event of session.stream()) second.push(event.type);
    expect(first).toEqual(["final", "session.stopped"]);
    expect(second).toEqual(first);
  });
});
