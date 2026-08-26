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
          route: { operation: "echo" },
        },
        invocationId: "invoke",
        ...(options.interaction ? { interaction: options.interaction } : {}),
        ...(options.preflight ? { preflight: options.preflight } : {}),
      },
    ],
    immediateResults: [],
  };
}

function context(adapters: Parameters<typeof createAdapterRegistry>[0]) {
  return {
    adapters: createAdapterRegistry(adapters),
    signal: new AbortController().signal,
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
    const run = context([{ id: "local", validateRoute() {}, execute }]);

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
    const run = context([{ id: "local", validateRoute() {}, preflight, execute }]);

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
    const run = context([{ id: "local", validateRoute() {}, execute }]);
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
});
