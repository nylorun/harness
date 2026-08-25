import { describe, expect, it, vi } from "vitest";
import { Harness } from "../src/index.js";
import { adapter, capability, model, tool, turn } from "./fixtures.js";

describe("sealing", () => {
  it("turns invalid calls into paired failures and dispatches only sealed calls", async () => {
    const execute = vi.fn(async (call) => ({ kind: "completed" as const, output: call.args }));
    let calls = 0;
    const result = await new Harness({
      model: model(async (request) => {
        calls += 1;
        return calls === 1
          ? {
              toolCalls: [
                { id: "unknown", name: "missing", args: {} },
                { id: "valid", name: "echo", args: { value: 1 } },
              ],
            }
          : `results:${request.toolResults.map((item) => item.kind).join(",")}`;
      }),
      adapters: { local: adapter(execute) },
    })
      .add(capability(tool()))
      .build();
    if (!result.ok) throw new Error("build failed");
    const output = (await turn(result.agent, "go").handle.completed).events;
    expect(output).toMatchObject([{ type: "final", output: "results:failed,completed" }]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(execute.mock.calls[0]![0])).toBe(true);
  });

  it("canonicalizes malformed call ids and deeply copies candidate and Tool result data", async () => {
    const candidateArgs = { value: 1 };
    const adapterOutput = { nested: { value: 1 } };
    let step = 0;
    const result = await new Harness({
      model: model(async (request) => {
        if (++step > 1) return "done";
        return {
          toolCalls: [
            { id: "", name: "echo", args: candidateArgs },
            { id: "duplicate", name: "echo", args: candidateArgs },
            { id: "duplicate", name: "echo", args: candidateArgs },
            { id: "valid", name: "echo", args: candidateArgs },
          ],
        };
      }),
      adapters: { local: adapter(async () => ({ kind: "completed", output: adapterOutput })) },
    })
      .add(capability(tool()))
      .build();
    if (!result.ok) throw new Error("build failed");
    const { session, handle } = turn(result.agent, "go");
    await handle.completed;

    candidateArgs.value = 9;
    adapterOutput.nested.value = 9;
    const candidate = session.state.transcript.find((entry) => entry.kind === "candidate");
    const results = session.state.transcript.find((entry) => entry.kind === "tool-results");
    if (!candidate || candidate.kind !== "candidate" || !results || results.kind !== "tool-results")
      throw new Error("missing transcript entries");
    const candidateIds = candidate.candidate.toolCalls?.map((call) => call.id) ?? [];
    expect(new Set(candidateIds).size).toBe(4);
    expect(results.results.map((item) => item.callId)).toEqual(candidateIds);
    expect(results.results.map((item) => item.code)).toEqual([
      "tool.invalid-call-id",
      "tool.duplicate-call-id",
      "tool.duplicate-call-id",
      undefined,
    ]);
    expect(candidate.candidate.toolCalls?.[3]?.args).toEqual({ value: 1 });
    expect(results.results[3]?.output).toEqual({ nested: { value: 1 } });
    expect(Object.isFrozen((results.results[3]?.output as { nested: object }).nested)).toBe(true);
  });

  it("normalizes malformed JavaScript model and adapter scalar fields into failures", async () => {
    const malformedModel = await new Harness({
      model: model(async () => ({ content: { invalid: true } }) as never),
    }).build();
    if (!malformedModel.ok) throw new Error("build failed");
    const modelCompletion = await turn(malformedModel.agent, "go").handle.completed;
    expect(modelCompletion.events).toMatchObject([
      { type: "tripwire", tripwire: { code: "model.failed" } },
    ]);

    let step = 0;
    const malformedAdapter = await new Harness({
      model: model(async () =>
        ++step === 1 ? { toolCalls: [{ id: "call", name: "echo", args: {} }] } : "done",
      ),
      adapters: {
        local: adapter(async () => ({ kind: "denied", reason: { mutable: true } }) as never),
      },
    })
      .add(capability(tool()))
      .build();
    if (!malformedAdapter.ok) throw new Error("build failed");
    const { session, handle } = turn(malformedAdapter.agent, "go");
    await handle.completed;
    const results = session.state.transcript.find((entry) => entry.kind === "tool-results");
    expect(results?.kind).toBe("tool-results");
    if (results?.kind === "tool-results")
      expect(results.results).toEqual([
        expect.objectContaining({
          kind: "failed",
          code: "tool.execution-failed",
          message: "Tool denial reason must be a string",
        }),
      ]);
  });
});
