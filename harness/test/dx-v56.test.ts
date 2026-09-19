import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Agent,
  ToolError,
  checkCompatibility,
  hashManifest,
  tool,
  capability,
  type ExecutionState,
  type Implementations,
} from "../src/index.js";
import { run as engineRun, bindingFromAgent } from "../src/engine/index.js";

describe("DX v5.6 ergonomics", () => {
  it("Agent() is usable without .build(); .use() returns a new agent", async () => {
    const agent = Agent({
      id: "support",
      name: "Support",
      instructions: "Be brief.",
      tools: [
        tool({
          name: "ping",
          input: z.object({}),
          async run() {
            return "pong";
          },
        }),
      ],
    });
    expect(agent.id).toBe("support");
    expect(agent.manifest.schemaVersion).toBe(2);
    const extended = agent.use({ id: "extra", instructions: ["Extra."] });
    expect(extended).not.toBe(agent);
    expect(agent.build()).toBe(agent.build());
    let calls = 0;
    const result = await agent.run({
      input: "hi",
      onModelCall: async () => {
        calls += 1;
        if (calls === 1)
          return { output: [{ type: "tool-call", id: "c", name: "ping", args: {} }] };
        return "pong done";
      },
    });
    expect(result.status).toBe("completed");
  });

  it("accepts ToolError and plain return values from tools", async () => {
    const agent = Agent({ id: "a", name: "A" })
      .use({
        id: "t",
        tools: [
          tool({
            name: "ok",
            input: z.object({}),
            effects: "read",
            async run() {
              return { ok: true };
            },
          }),
          tool({
            name: "bad",
            input: z.object({}),
            async run() {
              throw new ToolError("not_found", "missing");
            },
          }),
        ],
      })
      .build();
    let calls = 0;
    const ok = await agent.run({
      input: "go",
      onModelCall: async () => {
        calls += 1;
        if (calls === 1) return { output: [{ type: "tool-call", id: "1", name: "ok", args: {} }] };
        return "done";
      },
    });
    expect(ok.status).toBe("completed");

    calls = 0;
    const bad = await agent.run({
      input: "go",
      onModelCall: async () => {
        calls += 1;
        if (calls === 1) return { output: [{ type: "tool-call", id: "1", name: "bad", args: {} }] };
        return "done";
      },
    });
    expect(bad.status).toBe("completed");
    expect(JSON.stringify(bad.state)).toContain("not_found");
  });

  it("pauses on declarative tool approval and resumes", async () => {
    const agent = Agent({ id: "a", name: "A" })
      .use({
        id: "pay",
        tools: [
          tool({
            name: "refund",
            input: z.object({ amount: z.number() }),
            effects: "idempotent",
            approval: ({ amount }) => amount > 10 && `Refund $${amount}?`,
            async run({ amount }, ctx) {
              expect(ctx.idempotencyKey).toBeTruthy();
              return { refunded: amount };
            },
          }),
        ],
      })
      .build();
    const first = await agent.run({
      input: "go",
      onModelCall: async () => ({
        output: [{ type: "tool-call", id: "r", name: "refund", args: { amount: 50 } }],
      }),
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("expected pause");
    const interactionId = first.pending[0]!.interaction!.id;
    const second = await agent.run({
      state: first.state,
      input: { kind: "approve", interactionId, approved: true },
      onModelCall: async () => "done",
    });
    expect(second.status).toBe("completed");
  });
});

describe("DX v5.6 agent-as-JSON", () => {
  it("round-trips Agent.from(agent.toJSON(), implementations) with the same hash (T28)", async () => {
    const refund = tool({
      name: "refund",
      input: z.object({ amount: z.number() }),
      async run({ amount }) {
        return { amount };
      },
    });
    const agent = Agent({ id: "support", name: "Support", instructions: "Help." })
      .use({ id: "orders", tools: [refund], instructions: ["Look up first."] })
      .build();
    const json = agent.toJSON();
    expect(json).not.toHaveProperty("model");
    expect(hashManifest(json)).toBe(agent.hash);
    const implementations: Implementations = {
      agent: {},
      orders: { tools: { refund } },
    };
    const restored = Agent.from(json, implementations);
    expect(restored.hash).toBe(agent.hash);
    let calls = 0;
    const result = await restored.run({
      input: "go",
      onModelCall: async () => {
        calls += 1;
        if (calls === 1)
          return { output: [{ type: "tool-call", id: "1", name: "refund", args: { amount: 1 } }] };
        return "ok";
      },
    });
    expect(result.status).toBe("completed");
  });

  it("checkCompatibility fails on wrong manifest hash (D4)", () => {
    const a = Agent({ id: "a", name: "A", instructions: "one" }).build();
    const b = Agent({ id: "a", name: "A", instructions: "two" }).build();
    const state = {
      version: 1 as const,
      agentId: "a",
      manifestHash: a.hash,
      executionId: "execution_x",
      revision: 0,
      turnCount: 0,
      transcript: [],
      status: "ready" as const,
      state: {},
    };
    expect(checkCompatibility(a.manifest, state).ok).toBe(true);
    const bad = checkCompatibility(b.manifest, state);
    expect(bad.ok).toBe(false);
  });
});

describe("DX v5.6 durable acceptance", () => {
  it("D1 pause resume via engine", async () => {
    const agent = Agent({ id: "a", name: "A" })
      .use({
        id: "t",
        tools: [
          tool({
            name: "act",
            input: z.object({}),
            approval: () => "Proceed?",
            async run() {
              return "did";
            },
          }),
        ],
      })
      .build();
    const binding = bindingFromAgent(agent);
    const records: ExecutionState[] = [];
    const first = await engineRun({
      binding,
      input: "go",
      record: (state) => {
        records.push(state);
      },
      onModelCall: async () => ({
        output: [{ type: "tool-call", id: "1", name: "act", args: {} }],
      }),
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("pause");
    const serialized = JSON.parse(JSON.stringify(first.state)) as ExecutionState;
    const second = await engineRun({
      binding,
      state: serialized,
      input: {
        kind: "approve",
        interactionId: first.pending[0]!.interaction!.id,
        approved: true,
      },
      onModelCall: async () => "done",
    });
    expect(second.status).toBe("completed");
    expect(records.length).toBeGreaterThan(0);
  });

  it("D2 crash continue from last record", async () => {
    const agent = Agent({ id: "a", name: "A" })
      .use({
        id: "t",
        tools: [
          tool({
            name: "job",
            input: z.object({}),
            effects: "idempotent",
            async run(_args, ctx) {
              return { redelivery: Boolean(ctx.redelivery), key: ctx.idempotencyKey };
            },
          }),
        ],
      })
      .build();
    const binding = bindingFromAgent(agent);
    const records: ExecutionState[] = [];
    let calls = 0;
    const uninterrupted = await engineRun({
      binding,
      input: "go",
      record: (state) => {
        records.push(structuredClone(state));
      },
      onModelCall: async () => {
        calls += 1;
        if (calls === 1) return { output: [{ type: "tool-call", id: "1", name: "job", args: {} }] };
        return "done";
      },
    });
    expect(uninterrupted.status).toBe("completed");

    // Simulate crash after tools marked active but before settle: take an active checkpoint.
    const active = records.find((state) =>
      state.plan?.calls.some((call) => call.status === "active"),
    );
    expect(active).toBeTruthy();
    const resumed = await engineRun({
      binding,
      state: active!,
      input: { kind: "continue" },
      onModelCall: async () => "done",
    });
    expect(resumed.status).toBe("completed");
    expect(JSON.stringify(resumed.state)).toContain('"redelivery":true');
  });

  it("D6 ask wait parks and resumes", async () => {
    const agent = Agent({ id: "a", name: "A" })
      .use({
        id: "t",
        tools: [
          tool({
            name: "confirm",
            input: z.object({}),
            async run(_args, ctx) {
              const answer = await ctx.ask("Confirm?");
              return { answer };
            },
          }),
        ],
      })
      .build();
    const first = await agent.run({
      input: "go",
      onModelCall: async () => ({
        output: [{ type: "tool-call", id: "1", name: "confirm", args: {} }],
      }),
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("pause");
    const interactionId = first.pending[0]!.interaction!.id;
    const second = await agent.run({
      state: first.state,
      input: { kind: "respond", interactionId, value: "yes" },
      onModelCall: async () => "done",
    });
    expect(second.status).toBe("completed");
    expect(JSON.stringify(second.state)).toContain("yes");
  });
});

describe("DX v5.6 dynamics", () => {
  it("beforeModelCall can block; afterModelCall can deny tool calls", async () => {
    const ran = vi.fn(async () => "nope");
    const agent = Agent({ id: "a", name: "A", instructions: "Hi" })
      .use(
        capability({
          id: "policy",
          afterModelCall({ toolCalls }) {
            if (toolCalls.some((call) => call.name === "danger"))
              return {
                deny: toolCalls
                  .filter((call) => call.name === "danger")
                  .map((call) => ({ id: call.id, reason: "blocked" })),
              };
            return {};
          },
        }),
      )
      .use({
        id: "tools",
        tools: [
          tool({
            name: "danger",
            input: z.object({}),
            run: ran,
          }),
        ],
      })
      .build();

    let calls = 0;
    const result = await agent.run({
      input: "go",
      onModelCall: async () => {
        calls += 1;
        if (calls === 1)
          return { output: [{ type: "tool-call", id: "d", name: "danger", args: {} }] };
        return "done";
      },
    });
    expect(result.status).toBe("completed");
    expect(ran).not.toHaveBeenCalled();
    expect(agent.manifest.capabilities.some((item) => item.afterModelCall === true)).toBe(true);
  });

  it("writes session state from tools for beforeModelCall", async () => {
    const seen: unknown[] = [];
    const agent = Agent({ id: "a", name: "A" })
      .use({
        id: "t",
        tools: [
          tool({
            name: "flag",
            input: z.object({}),
            async run(_args, ctx) {
              ctx.state.set("escalated", true);
              return "ok";
            },
          }),
        ],
      })
      .beforeModelCall(({ state }) => {
        seen.push(state.escalated);
        return {};
      })
      .build();
    let calls = 0;
    await agent.run({
      input: "go",
      onModelCall: async () => {
        calls += 1;
        if (calls === 1)
          return { output: [{ type: "tool-call", id: "1", name: "flag", args: {} }] };
        return "done";
      },
    });
    expect(seen).toContain(true);
  });
});
