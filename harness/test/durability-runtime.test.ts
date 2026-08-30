import { describe, expect, it, vi } from "vitest";
import { Agent, type SessionRecord, type SessionSeed } from "../src/index.js";
import { model, offer, tool, toolCalls } from "./fixtures.js";

/** A deterministic stand-in for the persistence responsibilities outside Harness core. */
class DurabilityRuntime {
  private readonly history = new Map<string, SessionRecord[]>();
  private readonly leases = new Map<string, string>();
  private readonly effects = new Map<
    string,
    { readonly receipt: string; readonly amount: number }
  >();

  recorder(fail?: (record: SessionRecord) => boolean) {
    return {
      record: async (record: SessionRecord) => {
        if (fail?.(record)) throw new Error(`injected record failure at ${record.transition}`);
        const entries = this.history.get(record.session.id) ?? [];
        const previous = entries.at(-1);
        if (record.revision === (previous?.revision ?? 0) + 1) {
          entries.push(JSON.parse(JSON.stringify(record)) as SessionRecord);
          this.history.set(record.session.id, entries);
          return;
        }
        const duplicate = entries.find((item) => item.revision === record.revision);
        if (duplicate && JSON.stringify(duplicate) === JSON.stringify(record)) return;
        throw new Error(`stale record ${record.session.id}@${record.revision}`);
      },
    };
  }

  acquire(sessionId: string, owner: string): boolean {
    const current = this.leases.get(sessionId);
    if (current && current !== owner) return false;
    this.leases.set(sessionId, owner);
    return true;
  }

  release(sessionId: string, owner: string): void {
    if (this.leases.get(sessionId) === owner) this.leases.delete(sessionId);
  }

  effect(invocationId: string, amount: number) {
    const existing = this.effects.get(invocationId);
    if (existing) return existing;
    const receipt = { receipt: `receipt-${this.effects.size + 1}`, amount };
    this.effects.set(invocationId, receipt);
    return receipt;
  }

  effectCount(): number {
    return this.effects.size;
  }

  records(sessionId: string): readonly SessionRecord[] {
    return this.history.get(sessionId) ?? [];
  }

  seed(sessionId: string, extra: SessionSeed["transcript"] = []): SessionSeed {
    const latest = this.records(sessionId).at(-1);
    if (!latest) throw new Error(`missing persisted session ${sessionId}`);
    return {
      id: latest.session.id,
      ...(latest.session.userId === undefined ? {} : { userId: latest.session.userId }),
      ...(latest.session.context === undefined ? {} : { context: latest.session.context }),
      turnCount: latest.session.turnCount,
      revision: latest.revision,
      transcript: [...latest.transcript, ...extra],
    };
  }
}

function lastCandidate(seed: SessionSeed) {
  const entry = [...seed.transcript].reverse().find((item) => item.kind === "candidate");
  if (!entry || entry.kind !== "candidate") throw new Error("candidate is required for recovery");
  return entry;
}

function completedResult(seed: SessionSeed, output: unknown) {
  const candidate = lastCandidate(seed);
  return {
    kind: "tool-results" as const,
    turnId: candidate.turnId,
    stepId: candidate.stepId,
    results: [{ callId: "charge", toolName: "charge", kind: "completed" as const, output }],
  };
}

describe("durability runtime integration", () => {
  it("uses a lease and compare-and-set records to fence a competing resumer", async () => {
    const runtime = new DurabilityRuntime();
    const invoked = vi.fn(async () => "winner");
    const agent = Agent(model(invoked)).build();
    const sessionId = "competing-resumer";

    expect(runtime.acquire(sessionId, "worker-a")).toBe(true);
    expect(runtime.acquire(sessionId, "worker-b")).toBe(false);
    runtime.release(sessionId, "worker-a");
    expect(runtime.acquire(sessionId, "worker-b")).toBe(true);

    const first = agent.run({ id: sessionId, recorder: runtime.recorder() });
    const second = agent.run({ id: sessionId, recorder: runtime.recorder() });
    const outcomes = await Promise.allSettled([
      first.input("go").completed,
      second.input("go").completed,
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(invoked).toHaveBeenCalledTimes(1);
    expect(runtime.records(sessionId).map((record) => record.revision)).toEqual([1, 2, 3, 4]);
    expect(runtime.records(sessionId).at(-1)).toMatchObject({ transition: "final" });
    await runtime.recorder().record(runtime.records(sessionId).at(-1)!);
    expect(runtime.records(sessionId)).toHaveLength(4);
  });

  it("reconciles an effect that completed before the tool-results record failed", async () => {
    const runtime = new DurabilityRuntime();
    const sessionId = "ambiguous-effect";
    const agent = Agent(
      model(async (call) =>
        call.prompt.some((item) => item.kind === "tool-result")
          ? "reconciled"
          : toolCalls({ id: "charge", name: "charge", args: { amount: 7 } }),
      ),
    )
      .use(
        "tools",
        offer(
          tool("charge", async (args, context) => ({
            kind: "completed",
            output: runtime.effect(context.invocationId, Number(args.amount)),
          })),
        ),
      )
      .build();

    const interrupted = agent.run({
      id: sessionId,
      recorder: runtime.recorder((record) => record.transition === "tool-results"),
    });
    await expect(interrupted.input("charge").completed).rejects.toMatchObject({
      code: "session.record-failed",
    });
    expect(runtime.effectCount()).toBe(1);
    expect(runtime.records(sessionId).map((record) => record.transition)).toEqual([
      "input",
      "model-requested",
      "candidate",
    ]);

    const seed = runtime.seed(sessionId);
    const active = runtime.records(sessionId).at(-1)?.active;
    if (!active || active.kind !== "tools") throw new Error("missing persisted tool plan");
    const effect = runtime.effect(active.calls[0]!.invocationId, 7);
    const resumed = agent.run({
      seed: runtime.seed(sessionId, [completedResult(seed, effect)]),
      recorder: runtime.recorder(),
    });
    expect((await resumed.continue().completed).status).toBe("completed");
    expect(runtime.effectCount()).toBe(1);
    expect(runtime.records(sessionId).at(-1)).toMatchObject({ transition: "final" });
  });

  it("persists mixed settled and deferred siblings without a partial result batch", async () => {
    const runtime = new DurabilityRuntime();
    const sessionId = "mixed-deferred";
    const agent = Agent(
      model(async (call) =>
        call.prompt.some((item) => item.kind === "tool-result")
          ? "all settled"
          : toolCalls(
              { id: "fast", name: "fast", args: {} },
              { id: "slow", name: "slow", args: {} },
            ),
      ),
    )
      .use(
        "tools",
        offer(
          tool("fast", async () => ({ kind: "completed", output: "fast-result" })),
          tool("slow", async () => ({ kind: "deferred", token: { jobId: "slow-job" } })),
        ),
      )
      .build();

    const initial = agent.run({ id: sessionId, recorder: runtime.recorder() });
    expect((await initial.input("go").completed).status).toBe("waiting");
    const waiting = runtime.records(sessionId).at(-1);
    expect(waiting).toMatchObject({
      transition: "waiting",
      active: {
        kind: "tools",
        calls: [
          { callId: "fast", status: "settled" },
          { callId: "slow", status: "deferred", token: { jobId: "slow-job" } },
        ],
      },
    });
    expect(waiting?.transcript.some((entry) => entry.kind === "tool-results")).toBe(false);

    const seed = runtime.seed(sessionId);
    const candidate = lastCandidate(seed);
    const recovered = agent.run({
      seed: runtime.seed(sessionId, [
        {
          kind: "tool-results",
          turnId: candidate.turnId,
          stepId: candidate.stepId,
          results: [
            { callId: "fast", toolName: "fast", kind: "completed", output: "fast-result" },
            { callId: "slow", toolName: "slow", kind: "completed", output: "slow-result" },
          ],
        },
      ]),
      recorder: runtime.recorder(),
    });
    expect((await recovered.continue().completed).status).toBe("completed");
    expect(runtime.records(sessionId).at(-1)).toMatchObject({ transition: "final" });
  });

  it("recovers an interaction wait from an authenticated host-constructed tool result", async () => {
    const runtime = new DurabilityRuntime();
    const sessionId = "interaction-recovery";
    const agent = Agent(
      model(async (call) =>
        call.prompt.some((item) => item.kind === "tool-result")
          ? "approved after recovery"
          : toolCalls({ id: "charge", name: "charge", args: {} }),
      ),
    )
      .use(
        "tools",
        offer(
          tool("charge", async () => ({
            kind: "interaction-required",
            interaction: { kind: "approval", prompt: "approve charge" },
            token: { approvalRequest: "request-1" },
          })),
        ),
      )
      .build();

    const initial = agent.run({ id: sessionId, recorder: runtime.recorder() });
    expect((await initial.input("go").completed).status).toBe("waiting");
    const waiting = runtime.records(sessionId).at(-1);
    expect(waiting).toMatchObject({
      transition: "waiting",
      active: { kind: "interaction", interaction: { kind: "approval" } },
    });

    const seed = runtime.seed(sessionId);
    const resumed = agent.run({
      seed: runtime.seed(sessionId, [
        completedResult(seed, { approved: true, requestId: "request-1" }),
      ]),
      recorder: runtime.recorder(),
    });
    expect((await resumed.continue().completed).status).toBe("completed");
    expect(runtime.records(sessionId).at(-1)).toMatchObject({ transition: "final" });
  });
});
