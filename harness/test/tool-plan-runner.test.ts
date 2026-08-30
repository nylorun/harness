import { describe, expect, it, vi } from "vitest";
import { ToolPlanRunner } from "../src/turn/plan-runner.js";
import type { InternalToolPlan } from "../src/step/seal.js";

function plan(execute: (args: never, context: never) => Promise<never>): InternalToolPlan {
  return {
    candidate: { output: [] },
    order: [{ callId: "call", toolName: "echo" }],
    immediateResults: [],
    executable: [
      {
        call: { callId: "call", toolName: "echo", args: {} },
        invocationId: "invocation",
        owner: { middlewareId: "tools", slot: "main" },
        execute,
      },
    ],
  };
}

function context() {
  return {
    signal: new AbortController().signal,
    observe: vi.fn(),
    ids: { sessionId: "session", turnId: "turn", stepId: "step" },
  };
}

describe("ToolPlanRunner", () => {
  it("normalizes thrown implementations into failed results", async () => {
    const runner = new ToolPlanRunner(
      plan(async () => {
        throw new Error("boom");
      }),
    );
    await expect(runner.run(context())).resolves.toEqual({
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
  });

  it("returns deferred handoff facts without inventing a tool result", async () => {
    const runner = new ToolPlanRunner(
      plan(async () => ({ kind: "deferred", token: { jobId: "job" } }) as never),
    );
    await expect(runner.run(context())).resolves.toMatchObject({
      kind: "deferred",
      settled: [],
      deferred: [
        {
          callId: "call",
          invocationId: "invocation",
          owner: { middlewareId: "tools", slot: "main" },
          token: { jobId: "job" },
        },
      ],
    });
  });

  it("settles mixed sibling dispositions deterministically", async () => {
    const owner = { middlewareId: "tools", slot: "main" };
    const runner = new ToolPlanRunner({
      candidate: { output: [] },
      order: [
        { callId: "completed", toolName: "echo" },
        { callId: "denied", toolName: "echo" },
        { callId: "failed", toolName: "echo" },
        { callId: "deferred", toolName: "echo" },
      ],
      immediateResults: [{ callId: "denied", toolName: "echo", kind: "denied", reason: "policy" }],
      executable: [
        {
          call: { callId: "completed", toolName: "echo", args: {} },
          invocationId: "invocation-completed",
          owner,
          execute: async () => ({ kind: "completed", output: "ok" }),
        },
        {
          call: { callId: "failed", toolName: "echo", args: {} },
          invocationId: "invocation-failed",
          owner,
          execute: async () => ({ kind: "failed", code: "provider.failed", message: "no" }),
        },
        {
          call: { callId: "deferred", toolName: "echo", args: {} },
          invocationId: "invocation-deferred",
          owner,
          execute: async () => ({ kind: "deferred", token: "later" }),
        },
      ],
    });

    await expect(runner.run(context())).resolves.toMatchObject({
      kind: "deferred",
      settled: [
        { callId: "completed", kind: "completed" },
        { callId: "denied", kind: "denied" },
        { callId: "failed", kind: "failed", code: "provider.failed" },
      ],
      deferred: [{ callId: "deferred", token: "later" }],
    });
  });
});
