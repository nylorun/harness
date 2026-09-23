import { runAgent } from "./run-agent.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Agent, capability, tool, type ModelCall } from "@nylorun/core/define";
import type { ExecutionState } from "../src/index.js";

const callTool = (name: string, id = name, args: Record<string, unknown> = {}) => ({
  output: [{ type: "tool-call" as const, id, name, args }],
});
const toolNames = (call: ModelCall) => call.tools.map((item) => item.name).sort();
const promptText = (call: ModelCall) => JSON.stringify(call.prompt);

function twoTools() {
  return {
    id: "kit",
    tools: [
      tool({ name: "alpha", input: z.object({}), run: async () => "a" }),
      tool({ name: "beta", input: z.object({}), run: async () => "b" }),
    ],
  };
}

describe("before hooks", () => {
  it('runs before("turn") once per turn and before("step") on every model call', async () => {
    const turns = vi.fn(() => ({}));
    const steps = vi.fn(() => ({}));
    const agent = Agent({ id: "a" }).use(twoTools()).before("turn", turns).before("step", steps);
    let calls = 0;
    const result = await runAgent(agent, {
      input: "go",
      onModelCall: async () => (++calls < 3 ? callTool("alpha", `c${calls}`) : "done"),
    });
    expect(result.status).toBe("completed");
    expect(turns).toHaveBeenCalledTimes(1);
    expect(steps).toHaveBeenCalledTimes(3);
    expect(steps.mock.calls.map(([args]) => (args as { step: number }).step)).toEqual([0, 1, 2]);
    expect(turns.mock.calls[0]![0]).toMatchObject({ input: "go" });
    expect(result.state.turn).toBeUndefined();
  });

  it("applies the turn patch to every step and lets a step patch override it", async () => {
    const seen: string[][] = [];
    const prompts: string[] = [];
    const agent = Agent({ id: "a" })
      .use(twoTools())
      .before("turn", () => ({ tools: { beta: false }, instructions: ["TURN-RULE"] }))
      .before("step", ({ step }) =>
        step === 1 ? { tools: { beta: true }, instructions: ["STEP-RULE"] } : {},
      );
    let calls = 0;
    await runAgent(agent, {
      input: "go",
      onModelCall: async (call) => {
        seen.push(toolNames(call));
        prompts.push(promptText(call));
        return ++calls < 3 ? callTool("alpha", `c${calls}`) : "done";
      },
    });
    expect(seen).toEqual([["alpha"], ["alpha", "beta"], ["alpha"]]);
    expect(prompts.every((text) => text.includes("TURN-RULE"))).toBe(true);
    expect(prompts.map((text) => text.includes("STEP-RULE"))).toEqual([false, true, false]);
  });

  it("hides a capability's tools but keeps running its hooks", async () => {
    const hook = vi.fn(({ step }: { step: number }) => ({ active: step > 0 }));
    const agent = Agent({ id: "a" })
      .use({ ...twoTools(), before: { step: hook } })
      .use({
        id: "other",
        tools: [tool({ name: "gamma", input: z.object({}), run: async () => "g" })],
      });
    const seen: string[][] = [];
    let calls = 0;
    await runAgent(agent, {
      input: "go",
      onModelCall: async (call) => {
        seen.push(toolNames(call));
        return ++calls < 2 ? callTool("gamma") : "done";
      },
    });
    expect(seen).toEqual([["gamma"], ["alpha", "beta", "gamma"]]);
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it("turns off one tool of a multi-tool capability", async () => {
    const agent = Agent({ id: "a" }).use({
      ...twoTools(),
      before: { step: () => ({ tools: { alpha: false } }) },
    });
    const seen: string[][] = [];
    const result = await runAgent(agent, {
      input: "go",
      onModelCall: async (call) => {
        seen.push(toolNames(call));
        return "done";
      },
    });
    expect(result.status).toBe("completed");
    expect(seen).toEqual([["beta"]]);
  });

  it("rejects a capability toggling another capability's tools", async () => {
    const agent = Agent({ id: "a" })
      .use(twoTools())
      .use({ id: "rogue", before: { step: () => ({ tools: { alpha: false } }) } });
    const result = await runAgent(agent, { input: "go", onModelCall: async () => "done" });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.error.message).toMatch(/may only toggle its own tools/);
  });

  it('blocks the turn from before("turn")', async () => {
    const model = vi.fn(async () => "done");
    const agent = Agent({ id: "a" }).before("turn", () => ({ block: "not today" }));
    const result = await runAgent(agent, { input: "go", onModelCall: model });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.error).toMatchObject({ code: "dynamics.blocked", message: "not today" });
    expect(model).not.toHaveBeenCalled();
  });

  it("sees session state written by tools", async () => {
    const seen: unknown[] = [];
    const agent = Agent({ id: "a" })
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
      .before("step", ({ state }) => {
        seen.push(state.escalated);
        return {};
      });
    let calls = 0;
    await runAgent(agent, {
      input: "go",
      onModelCall: async () => (++calls === 1 ? callTool("flag") : "done"),
    });
    expect(seen).toEqual([undefined, true]);
  });

  it('does not re-run before("turn") when a paused turn resumes', async () => {
    const turns = vi.fn(() => ({ instructions: ["TURN-RULE"] }));
    const agent = Agent({ id: "a" })
      .use({
        id: "pay",
        tools: [
          tool({
            name: "refund",
            input: z.object({}),
            approval: () => "Refund?",
            run: async () => "refunded",
          }),
        ],
      })
      .before("turn", turns);
    const first = await runAgent(agent, {
      input: "go",
      onModelCall: async () => callTool("refund"),
    });
    if (first.status !== "paused") throw new Error("expected pause");
    expect(first.state.turn?.patch).toEqual({ instructions: ["TURN-RULE"] });
    const prompts: string[] = [];
    const second = await runAgent(agent, {
      state: first.state,
      input: { kind: "approve", interactionId: first.pending[0]!.interaction!.id, approved: true },
      onModelCall: async (call) => {
        prompts.push(promptText(call));
        return "done";
      },
    });
    expect(second.status).toBe("completed");
    expect(turns).toHaveBeenCalledTimes(1);
    expect(prompts[0]).toContain("TURN-RULE");
  });

  it('does not re-run before("turn") on crash-continue within the turn', async () => {
    const turns = vi.fn(() => ({}));
    const agent = Agent({ id: "a" }).use(twoTools()).before("turn", turns);
    const recorded: ExecutionState[] = [];
    await runAgent(agent, {
      input: "go",
      record: async (state) => {
        recorded.push(state);
      },
      onModelCall: async () => {
        throw new Error("crash");
      },
    });
    const interrupted = recorded.find((state) => state.turn && state.status === "active");
    if (!interrupted) throw new Error("expected an in-flight turn record");
    const resumed = await runAgent(agent, {
      state: interrupted,
      input: { kind: "continue" },
      onModelCall: async () => "done",
    });
    expect(resumed.status).toBe("completed");
    expect(turns).toHaveBeenCalledTimes(1);
    expect(resumed.state.turnCount).toBe(interrupted.turnCount);
  });
});

describe("after hooks", () => {
  it('denies proposed calls from after("step")', async () => {
    const ran = vi.fn(async () => "nope");
    const agent = Agent({ id: "a" })
      .use(
        capability({
          id: "policy",
          after: {
            step: ({ toolCalls }) => ({
              deny: toolCalls
                .filter((call) => call.name === "danger")
                .map((call) => ({ id: call.id, reason: "blocked" })),
            }),
          },
        }),
      )
      .use({ id: "tools", tools: [tool({ name: "danger", input: z.object({}), run: ran })] })
      .build();
    let calls = 0;
    const result = await runAgent(agent, {
      input: "go",
      onModelCall: async () => (++calls === 1 ? callTool("danger", "d") : "done"),
    });
    expect(result.status).toBe("completed");
    expect(ran).not.toHaveBeenCalled();
  });

  it('retries tool calls from after("step") by denying them with the feedback', async () => {
    const ran = vi.fn(async () => "a");
    const attempts: number[] = [];
    const agent = Agent({ id: "a" })
      .use({ id: "kit", tools: [tool({ name: "alpha", input: z.object({}), run: ran })] })
      .after("step", ({ toolCalls, attempt }) => {
        attempts.push(attempt);
        return toolCalls.length && attempt < 2 ? { retry: "Use fewer tools" } : {};
      });
    const prompts: string[] = [];
    let calls = 0;
    const result = await runAgent(agent, {
      input: "go",
      onModelCall: async (call) => {
        prompts.push(promptText(call));
        return ++calls <= 3 ? callTool("alpha", `c${calls}`) : "done";
      },
    });
    expect(result.status).toBe("completed");
    expect(attempts).toEqual([0, 1, 2, 2]);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(prompts[1]).toContain("Use fewer tools");
  });

  it('retries a text answer from after("step") and keeps the original input', async () => {
    const inputs: unknown[] = [];
    const agent = Agent({ id: "a" })
      .before("step", ({ input }) => {
        inputs.push(input);
        return {};
      })
      .after("step", ({ text, attempt }) =>
        text === "draft" && attempt === 0 ? { retry: "Be more specific" } : {},
      );
    const answers = ["draft", "final"];
    const prompts: string[] = [];
    const result = await runAgent(agent, {
      input: "question",
      onModelCall: async (call) => {
        prompts.push(promptText(call));
        return answers.shift()!;
      },
    });
    expect(result).toMatchObject({ status: "completed", output: "final" });
    expect(prompts[1]).toContain("draft");
    expect(prompts[1]).toContain("Be more specific");
    expect(inputs).toEqual(["question", "question"]);
  });

  it("retries a structured answer without failing output validation", async () => {
    const agent = Agent({ id: "a", outputSchema: z.object({ answer: z.string() }) }).after(
      "step",
      ({ attempt }) => (attempt === 0 ? { retry: "Answer in JSON" } : {}),
    );
    const replies = ["not json", { output: [{ type: "json" as const, value: { answer: "ok" } }] }];
    const result = await runAgent(agent, {
      input: "go",
      onModelCall: async () => replies.shift()!,
    });
    expect(result).toMatchObject({ status: "completed", output: { answer: "ok" } });
  });

  it('replaces the final text from after("turn") so the next turn sees it', async () => {
    const agent = Agent({ id: "a" }).after("turn", ({ text }) => ({
      text: `${text} [reviewed]`,
    }));
    const first = await runAgent(agent, { input: "one", onModelCall: async () => "answer" });
    expect(first).toMatchObject({ status: "completed", output: "answer [reviewed]" });
    const prompts: string[] = [];
    await runAgent(agent, {
      state: first.state,
      input: "two",
      onModelCall: async (call) => {
        prompts.push(promptText(call));
        return "again";
      },
    });
    expect(prompts[0]).toContain("answer [reviewed]");
  });

  it('replaces structured output from after("turn") and rejects text', async () => {
    const schema = z.object({ answer: z.string() });
    const json = { output: [{ type: "json" as const, value: { answer: "raw" } }] };
    const replaced = await runAgent(
      Agent({ id: "a", outputSchema: schema }).after("turn", () => ({
        output: { answer: "clean" },
      })),
      { input: "go", onModelCall: async () => json },
    );
    expect(replaced).toMatchObject({ status: "completed", output: { answer: "clean" } });
    const wrong = await runAgent(
      Agent({ id: "a", outputSchema: schema }).after("turn", () => ({ text: "nope" })),
      { input: "go", onModelCall: async () => json },
    );
    expect(wrong.status).toBe("failed");
  });

  it('blocks and retries from after("turn")', async () => {
    const blocked = await runAgent(
      Agent({ id: "a" }).after("turn", () => ({ block: "unsafe" })),
      { input: "go", onModelCall: async () => "answer" },
    );
    expect(blocked.status).toBe("failed");
    const attempts: number[] = [];
    const answers = ["short", "long enough"];
    const retried = await runAgent(
      Agent({ id: "a" }).after("turn", ({ text, attempt }) => {
        attempts.push(attempt);
        return text === "short" ? { retry: "Longer, please" } : {};
      }),
      { input: "go", onModelCall: async () => answers.shift()! },
    );
    expect(retried).toMatchObject({ status: "completed", output: "long enough" });
    expect(attempts).toEqual([0, 1]);
  });

  it("runs every capability's hook at a point concurrently in one batch", async () => {
    let active = 0;
    let peak = 0;
    const slow = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return {};
    };
    const agent = Agent({ id: "a" })
      .use({ id: "one", before: { step: slow } })
      .use({ id: "two", before: { step: slow } });
    await runAgent(agent, { input: "go", onModelCall: async () => "done" });
    expect(peak).toBe(2);
  });

  it("turns a throwing hook into a block for that capability", async () => {
    const agent = Agent({ id: "a" }).use({
      id: "guard",
      after: {
        step: () => {
          throw new Error("guard exploded");
        },
      },
    });
    const result = await runAgent(agent, { input: "go", onModelCall: async () => "done" });
    expect(result.status).toBe("failed");
    if (result.status !== "failed") throw new Error("expected failure");
    expect(result.error.message).toBe("guard exploded");
  });
});
