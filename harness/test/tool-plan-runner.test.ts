import { describe, expect, it, vi } from "vitest";
import { createAdapterRegistry } from "../src/build/adapters.js";
import { ToolPlanRunner } from "../src/turn/plan-runner.js";
import type { InternalToolPlan } from "../src/step/seal.js";

function plan(
  options: {
    interaction?: { id: string; kind: "approval" | "response"; prompt: string };
    preflight?: "sandbox" | "validation";
  } = {},
): InternalToolPlan {
  return {
    candidate: {
      output: [{ type: "tool-call", id: "call", name: "echo", args: { text: "hello" } }],
    },
    order: [{ callId: "call", toolName: "echo" }],
    executable: [
      {
        call: {
          callId: "call",
          toolName: "echo",
          args: { text: "hello" },
          executeWith: "local",
        },
        invocationId: "invoke",
        ...(options.interaction ? { interaction: options.interaction } : {}),
        ...(options.preflight ? { preflight: options.preflight } : {}),
      },
    ],
    immediateResults: [],
  };
}

function multiPlan(
  calls: readonly { readonly id: string; readonly name?: string; readonly executeWith?: string }[],
): InternalToolPlan {
  return {
    candidate: {
      output: calls.map((call) => ({
        type: "tool-call" as const,
        id: call.id,
        name: call.name ?? "echo",
        args: {},
      })),
    },
    order: calls.map((call) => ({ callId: call.id, toolName: call.name ?? "echo" })),
    executable: calls.map((call) => ({
      call: {
        callId: call.id,
        toolName: call.name ?? "echo",
        args: {},
        executeWith: call.executeWith ?? "local",
      },
      invocationId: `invoke-${call.id}`,
    })),
    immediateResults: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function context(
  adapters: Parameters<typeof createAdapterRegistry>[0],
  signal = new AbortController().signal,
) {
  return {
    adapters: createAdapterRegistry(adapters),
    signal,
    observe: vi.fn(),
    ids: { sessionId: "session", turnId: "turn", stepId: "step" },
  };
}

describe("ToolPlanRunner", () => {
  it("returns ordered denial results without entering an adapter", async () => {
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "unexpected" }));
    const runner = new ToolPlanRunner(
      plan({ interaction: { id: "approval", kind: "approval", prompt: "Approve?" } }),
    );
    const run = context([{ id: "local", execute }]);

    await expect(runner.run(run)).resolves.toMatchObject({
      kind: "interaction-required",
      interaction: { id: "approval" },
    });
    await expect(
      runner.run(run, { kind: "approve", interactionId: "approval", approved: false }),
    ).resolves.toEqual({
      kind: "completed",
      results: [
        expect.objectContaining({ callId: "call", kind: "denied", reason: "Approval rejected" }),
      ],
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("resumes a preflight interaction with its opaque token before executing", async () => {
    const preflight = vi.fn(async (_call, value) =>
      value.resume
        ? { kind: "completed" as const }
        : {
            kind: "interaction-required" as const,
            interaction: { id: "response", kind: "response" as const, prompt: "Continue?" },
            token: "opaque",
          },
    );
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "ok" }));
    const runner = new ToolPlanRunner(plan({ preflight: "validation" }));
    const run = context([{ id: "local", preflight, execute }]);

    await expect(runner.run(run)).resolves.toMatchObject({
      kind: "interaction-required",
      interaction: { id: "response" },
    });
    await expect(
      runner.run(run, { kind: "respond", interactionId: "response", value: "yes" }),
    ).resolves.toMatchObject({
      kind: "completed",
      results: [expect.objectContaining({ kind: "completed", output: "ok" })],
    });
    expect(preflight.mock.calls[1]?.[1].resume).toMatchObject({ token: "opaque", value: "yes" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("emits adapter.completed failed when execute throws and still returns results", async () => {
    const execute = vi.fn(async () => {
      throw new Error("boom");
    });
    const runner = new ToolPlanRunner(plan());
    const run = context([{ id: "local", execute }]);
    await expect(runner.run(run)).resolves.toEqual({
      kind: "completed",
      results: [
        expect.objectContaining({
          callId: "call",
          kind: "failed",
          code: "tool.execution-failed",
          message: "boom",
        }),
      ],
    });
    expect(run.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "adapter.started",
        toolName: "echo",
        callId: "call",
        attributes: { args: { text: "hello" } },
      }),
    );
    expect(run.observe).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "adapter.completed",
        toolName: "echo",
        callId: "call",
        outcome: "failed",
        code: "tool.execution-failed",
        attributes: expect.objectContaining({ kind: "failed", message: "boom" }),
      }),
    );
  });

  it("starts an unconfigured adapter's sibling calls in parallel and preserves result order", async () => {
    const started: string[] = [];
    const pending = new Map(
      ["first", "second", "third"].map((id) => [
        id,
        deferred<{ kind: "completed"; output: string }>(),
      ]),
    );
    const execute = vi.fn((call: { callId: string }) => {
      started.push(call.callId);
      return pending.get(call.callId)!.promise;
    });
    const runner = new ToolPlanRunner(
      multiPlan(["first", "second", "third"].map((id) => ({ id }))),
    );
    const run = context([{ id: "local", execute }]);

    const progress = runner.run(run);
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
    pending.get("third")!.resolve({ kind: "completed", output: "third" });
    pending.get("second")!.resolve({ kind: "completed", output: "second" });
    pending.get("first")!.resolve({ kind: "completed", output: "first" });

    await expect(progress).resolves.toEqual({
      kind: "completed",
      results: [
        expect.objectContaining({ callId: "first", output: "first" }),
        expect.objectContaining({ callId: "second", output: "second" }),
        expect.objectContaining({ callId: "third", output: "third" }),
      ],
    });
  });

  it("applies an adapter limit as a FIFO dispatch cap", async () => {
    const started: string[] = [];
    const pending = new Map(
      ["first", "second", "third"].map((id) => [
        id,
        deferred<{ kind: "completed"; output: string }>(),
      ]),
    );
    const execute = vi.fn((call: { callId: string }) => {
      started.push(call.callId);
      return pending.get(call.callId)!.promise;
    });
    const runner = new ToolPlanRunner(
      multiPlan(["first", "second", "third"].map((id) => ({ id }))),
    );
    const run = context([
      { adapter: { id: "local", execute }, options: { maxConcurrentCalls: 2 } },
    ]);

    const progress = runner.run(run);
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    pending.get("second")!.resolve({ kind: "completed", output: "second" });
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
    pending.get("first")!.resolve({ kind: "completed", output: "first" });
    pending.get("third")!.resolve({ kind: "completed", output: "third" });
    await expect(progress).resolves.toMatchObject({ kind: "completed" });
  });

  it("admits limited adapters independently", async () => {
    const started: string[] = [];
    const first = deferred<{ kind: "completed"; output: string }>();
    const second = deferred<{ kind: "completed"; output: string }>();
    const runner = new ToolPlanRunner(
      multiPlan([
        { id: "local-call", executeWith: "local" },
        { id: "remote-call", executeWith: "remote" },
      ]),
    );
    const run = context([
      {
        adapter: {
          id: "local",
          execute: async () => {
            started.push("local");
            return first.promise;
          },
        },
        options: { maxConcurrentCalls: 1 },
      },
      {
        adapter: {
          id: "remote",
          execute: async () => {
            started.push("remote");
            return second.promise;
          },
        },
        options: { maxConcurrentCalls: 1 },
      },
    ]);

    const progress = runner.run(run);
    await vi.waitFor(() => expect(started).toEqual(["local", "remote"]));
    first.resolve({ kind: "completed", output: "local" });
    second.resolve({ kind: "completed", output: "remote" });
    await expect(progress).resolves.toMatchObject({ kind: "completed" });
  });

  it("releases a running adapter permit after cancellation", async () => {
    const controller = new AbortController();
    const execute = vi.fn(
      async (_call: unknown, value: { signal: AbortSignal }) =>
        new Promise<{ kind: "completed"; output: string }>((resolve) => {
          value.signal.addEventListener(
            "abort",
            () => resolve({ kind: "completed", output: "ignored" }),
            { once: true },
          );
        }),
    );
    const runner = new ToolPlanRunner(multiPlan([{ id: "call" }]));
    const run = context(
      [{ adapter: { id: "local", execute }, options: { maxConcurrentCalls: 1 } }],
      controller.signal,
    );

    const progress = runner.run(run);
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    controller.abort(new Error("stop"));
    await expect(progress).rejects.toThrow("stop");
    await expect(
      run.adapters.execute("local", new AbortController().signal, async () => "later"),
    ).resolves.toBe("later");
  });

  it("queues concurrent execution interactions in model order and resumes each call", async () => {
    const execute = vi.fn(async (call: { callId: string }, value: { resume?: unknown }) => {
      if (value.resume) return { kind: "completed" as const, output: `resumed-${call.callId}` };
      return {
        kind: "interaction-required" as const,
        interaction: { id: `ask-${call.callId}`, kind: "response" as const, prompt: call.callId },
        token: call.callId,
      };
    });
    const runner = new ToolPlanRunner(multiPlan([{ id: "first" }, { id: "second" }]));
    const run = context([{ id: "local", execute }]);

    await expect(runner.run(run)).resolves.toMatchObject({
      kind: "interaction-required",
      interaction: { id: "ask-first" },
    });
    await expect(
      runner.run(run, { kind: "respond", interactionId: "ask-first", value: "one" }),
    ).resolves.toMatchObject({
      kind: "interaction-required",
      interaction: { id: "ask-second" },
    });
    await expect(
      runner.run(run, { kind: "respond", interactionId: "ask-second", value: "two" }),
    ).resolves.toEqual({
      kind: "completed",
      results: [
        expect.objectContaining({ callId: "first", output: "resumed-first" }),
        expect.objectContaining({ callId: "second", output: "resumed-second" }),
      ],
    });
  });
});
