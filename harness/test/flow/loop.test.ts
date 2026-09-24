import { describe, expect, it } from "vitest";
import { Agent, Loop, hashManifest } from "@nylorun/core/define";
import {
  createFlowCheckpoint,
  runFlowDurable,
  type DurableHost,
  type EffectResolution,
  type HostEffect,
} from "../../src/run/index.js";

describe("flow Loop (tracer)", () => {
  it("runs two iterations through agent → verify → decide effects", async () => {
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const workflow = Loop({
      id: "polish",
      run: writer,
      verify: ({ iteration }) =>
        iteration === 1 ? { pass: false, feedback: "try again" } : { pass: true },
      decide: ({ verdict, output }) => (verdict.pass ? { output } : { input: verdict.feedback }),
    });
    const manifest = workflow.manifest;
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "wf-1",
      turnId: "turn-1",
      input: "draft",
    });
    expect(checkpoint.manifestHash).toBe(hashManifest(manifest));

    const journal = new Map<string, EffectResolution>();
    const kinds: string[] = [];
    const host: DurableHost = {
      async resolveEffect(effect: HostEffect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        kinds.push(`${effect.kind}@${effect.iterations}`);
        let resolution: EffectResolution;
        if (effect.kind === "agent") {
          const n = Number(effect.iterations);
          resolution = {
            status: "completed",
            outcome: { value: n === 1 ? "draft-v1" : "draft-v2" },
          };
        } else if (effect.kind === "verify") {
          const input = effect.input as { iteration: number };
          resolution = {
            status: "completed",
            outcome: {
              value:
                input.iteration === 1 ? { pass: false, feedback: "try again" } : { pass: true },
            },
          };
        } else if (effect.kind === "fn") {
          const input = effect.input as {
            verdict: { pass: boolean; feedback?: string };
            output: string;
          };
          resolution = {
            status: "completed",
            outcome: {
              value: input.verdict.pass
                ? { output: input.output }
                : { input: input.verdict.feedback },
            },
          };
        } else {
          throw new Error(`unexpected ${effect.kind}`);
        }
        journal.set(effect.effectId, resolution);
        return resolution;
      },
    };

    const result = await runFlowDurable({ manifest, checkpoint, host });
    expect(result.status).toBe("completed");
    if (result.status !== "completed") throw new Error("expected completed");
    expect(result.result).toEqual({ status: "completed", output: "draft-v2" });
    expect(kinds).toEqual(["agent@1", "verify@1", "fn@1", "agent@2", "verify@2", "fn@2"]);

    // Replay reuses journaled effects; no extra host work.
    const replay = await runFlowDurable({ manifest, checkpoint, host });
    expect(replay).toEqual(result);
    expect(kinds).toHaveLength(6);
  });

  it("returns waiting when the agent effect is pending, then resumes", async () => {
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const workflow = Loop({
      id: "polish",
      run: writer,
      verify: () => ({ pass: true }),
      decide: ({ output }) => ({ output }),
    });
    const manifest = workflow.manifest;
    const checkpoint = createFlowCheckpoint({
      manifest,
      sessionId: "wf-1",
      turnId: "turn-1",
      input: "hi",
    });
    const journal = new Map<string, EffectResolution>();
    let agentEffectId = "";
    const host: DurableHost = {
      async resolveEffect(effect) {
        const recorded = journal.get(effect.effectId);
        if (recorded) return recorded;
        if (effect.kind === "agent") {
          agentEffectId = effect.effectId;
          const pending = { status: "pending" as const };
          journal.set(effect.effectId, pending);
          return pending;
        }
        const completed = {
          status: "completed" as const,
          outcome: {
            value: effect.kind === "verify" ? { pass: true } : { output: "done" },
          },
        };
        journal.set(effect.effectId, completed);
        return completed;
      },
    };

    const first = await runFlowDurable({ manifest, checkpoint, host });
    expect(first.status).toBe("waiting");
    if (!("effectIds" in first)) throw new Error("expected waiting");
    expect(first.effectIds).toEqual([agentEffectId]);

    journal.set(agentEffectId, {
      status: "completed",
      outcome: { value: "done" },
    });
    const second = await runFlowDurable({ manifest, checkpoint, host });
    expect(second.status).toBe("completed");
    if (second.status !== "completed") throw new Error("expected completed");
    expect(second.result).toEqual({ status: "completed", output: "done" });
  });
});
