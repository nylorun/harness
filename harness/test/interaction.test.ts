import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/index.js";
import { adapter, offer, model, tool, toolCalls, turn } from "./fixtures.js";

describe("interaction resume", () => {
  it("retains the plan, resumes the same invocation, and runs preflights before calls", async () => {
    const invocationIds: string[] = [];
    const order: string[] = [];
    const positions: { turnNumber: number; stepNumber: number }[] = [];
    const execute = vi.fn(async (_call, context) => {
      invocationIds.push(context.invocationId);
      order.push("execute");
      return { kind: "completed" as const, output: "ok" };
    });
    const local = {
      ...adapter(execute),
      async preflight(
        _call: unknown,
        context: { invocationId: string; resume?: { approved?: boolean } },
      ) {
        invocationIds.push(context.invocationId);
        order.push(context.resume ? "preflight-resumed" : "preflight");
        return context.resume
          ? { kind: "completed" as const }
          : {
              kind: "interaction-required" as const,
              interaction: { kind: "approval" as const, prompt: "approve" },
              token: "opaque",
            };
      },
    };
    let step = 0;
    const result = Agent(
      model(async () =>
        ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
      ),
    )
      .with(local)
      .use("preflight", async (request, next) => {
        positions.push({
          turnNumber: request.turnNumber,
          stepNumber: request.stepNumber,
        });
        const response = await next();
        response.requirePreflight("call", "validation");
        return response;
      })
      .use("test", offer(tool()))
      .build();
    const { session, handle: streamed } = turn(result, "go");
    const first = await streamed.completed;
    expect(first.status).toBe("waiting");
    const required = first.events.find((event) => event.type === "interaction.required");
    if (!required || required.type !== "interaction.required")
      throw new Error("missing interaction");
    const resumed = await session.input({
      kind: "approve",
      interactionId: required.interaction.id,
      approved: true,
    }).completed;
    expect(resumed.events.at(-1)).toMatchObject({ type: "final", output: "done" });
    expect(order).toEqual(["preflight", "preflight-resumed", "execute"]);
    expect(new Set(invocationIds).size).toBe(1);
    expect(positions).toEqual([
      { turnNumber: 1, stepNumber: 1 },
      { turnNumber: 1, stepNumber: 2 },
    ]);
  });

  it("rejects stale correlation without exposing it to the Model", async () => {
    const invoke = vi.fn(async () => "done");
    const result = Agent(model(invoke)).build();
    const completion = await turn(result, {
      kind: "approve",
      interactionId: "stale",
      approved: true,
    }).handle.completed;
    expect(completion.status).toBe("rejected");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("pairs every unresolved call when cancelling an interaction wait, then preserves FIFO", async () => {
    let modelStep = 0;
    const result = Agent(
      model(async () =>
        ++modelStep === 1
          ? toolCalls(
              { id: "first-call", name: "first", args: {} },
              { id: "second-call", name: "second", args: {} },
            )
          : "after-cancel",
      ),
    )
      .with(adapter())
      .use("approval", async (_request, next) => {
        const response = await next();
        response.requireInteraction("first-call", { kind: "approval", prompt: "approve" });
        return response;
      })
      .use("test", offer(tool("first"), tool("second")))
      .build();
    const firstController = new AbortController();
    const firstRemove = vi.spyOn(firstController.signal, "removeEventListener");
    const { session, handle: streamed } = turn(result, "wait", {
      signal: firstController.signal,
    });
    const first = await streamed.completed;
    expect(first.status).toBe("waiting");
    expect(firstRemove).toHaveBeenCalledWith("abort", expect.any(Function));

    const cancelledController = new AbortController();
    const cancelledRemove = vi.spyOn(cancelledController.signal, "removeEventListener");
    const cancelledQueued = session.input("remove-me", { signal: cancelledController.signal });
    cancelledController.abort(new Error("not needed"));
    await expect(cancelledQueued.completed).resolves.toMatchObject({ status: "cancelled" });
    expect(cancelledRemove).toHaveBeenCalledWith("abort", expect.any(Function));

    await session.stop("cancel pending plan");
    expect(session.state.status).toBe("stopped");
    const resultsEntry = session.state.transcript.find((entry) => entry.kind === "tool-results");
    expect(resultsEntry?.kind).toBe("tool-results");
    if (resultsEntry?.kind === "tool-results")
      expect(resultsEntry.results).toEqual([
        expect.objectContaining({ callId: "first-call", kind: "failed", code: "tool.cancelled" }),
        expect.objectContaining({ callId: "second-call", kind: "failed", code: "tool.cancelled" }),
      ]);
  });

  it("resumes an interaction after a delay without a harness deadline", async () => {
    let modelStep = 0;
    const local = adapter(async () => {
      await new Promise((resolve) => setTimeout(resolve, 35));
      return { kind: "completed", output: "too late" };
    });
    const result = Agent(
      model(async () =>
        ++modelStep === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
      ),
    )
      .with(local)
      .use("approval", async (_request, next) => {
        const response = await next();
        response.requireInteraction("call", { kind: "approval", prompt: "approve" });
        return response;
      })
      .use("test", offer(tool()))
      .build();
    const { session, handle: streamed } = turn(result, "go");
    const first = await streamed.completed;
    const required = first.events.find((event) => event.type === "interaction.required");
    if (!required || required.type !== "interaction.required")
      throw new Error("missing interaction");
    await new Promise((resolve) => setTimeout(resolve, 65));
    const resumed = await session.input({
      kind: "approve",
      interactionId: required.interaction.id,
      approved: true,
    }).completed;
    expect(resumed.status).toBe("completed");
    expect(resumed.events[0]).toMatchObject({
      type: "input",
      event: { kind: "approve", approved: true },
    });
    expect(resumed.events.some((event) => event.type === "candidate")).toBe(true);
    expect(resumed.events.at(-1)).toMatchObject({ type: "final", output: "done" });
  });
});
