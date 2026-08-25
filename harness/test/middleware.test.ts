import { describe, expect, it, vi } from "vitest";
import { Agent, defineCapability, defineMiddleware } from "../src/index.js";
import { adapter, model, tool, turn } from "./fixtures.js";

describe("middleware", () => {
  it("runs before handlers in order and around handlers as an exactly-once onion", async () => {
    const order: string[] = [];
    const one = defineMiddleware({
      id: "one",
      beforeModel(ctx) {
        order.push("before-one");
        ctx.addInstructions("extra");
      },
      async aroundModel(_ctx, next) {
        order.push("enter-one");
        await next();
        order.push("exit-one");
      },
    });
    const two = defineMiddleware({
      id: "two",
      beforeModel() {
        order.push("before-two");
      },
      async aroundModel(_ctx, next) {
        order.push("enter-two");
        await next();
        order.push("exit-two");
      },
    });
    const result = Agent.create({
      model: model(async (request) => {
        order.push(`model:${request.instructions.at(-1)}`);
        return "done";
      }),
      adapters: { local: adapter() },
    })
      .with(defineCapability({ id: "mw", middleware: [one], setup: () => ({ middleware: [two] }) }))
      .build();
    await turn(result, "go").handle.completed;
    expect(order).toEqual([
      "before-one",
      "before-two",
      "enter-one",
      "enter-two",
      "model:extra",
      "exit-two",
      "exit-one",
    ]);
  });

  it("tripwires conflicting model selection", async () => {
    const select = (id: string, modelId: string) =>
      defineMiddleware({
        id,
        beforeModel(ctx) {
          ctx.selectModel(modelId);
        },
      });
    const result = Agent.create({
      models: { a: model(async () => "a"), b: model(async () => "b") },
      defaultModel: "a",
      adapters: {},
    })
      .with(defineCapability({ id: "mw", middleware: [select("a", "a"), select("b", "b")] }))
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "tripwire", tripwire: { code: "model.selection-conflict" } },
    ]);
  });

  it("joins the exact next promise when middleware uses void next()", async () => {
    const order: string[] = [];
    const middleware = defineMiddleware({
      id: "fire-and-forget",
      async aroundModel(_ctx, next) {
        order.push("middleware-entered");
        void next();
        order.push("middleware-returned");
      },
    });
    const result = Agent.create({
      model: model(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        order.push("model-completed");
        return "done";
      }),
    })
      .with(defineCapability({ id: "mw", middleware: [middleware] }))
      .build();

    const output = (await turn(result, "go").handle.completed).events;

    expect(order).toEqual(["middleware-entered", "middleware-returned", "model-completed"]);
    expect(output).toMatchObject([{ type: "final", output: "done" }]);
  });

  it("keeps Step restrictions and the candidate behind frozen narrow facades", async () => {
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "unexpected" }));
    const facadeChecks: boolean[] = [];
    const attacker = defineMiddleware({
      id: "attacker",
      beforeModel(ctx) {
        const raw = ctx as unknown as Record<string, unknown>;
        facadeChecks.push(Object.isFrozen(ctx), raw.hiddenTools === undefined);
        (raw.hiddenTools as { clear?: () => void } | undefined)?.clear?.();
      },
      async aroundModel(ctx, next) {
        await next();
        const raw = ctx as unknown as Record<string, unknown>;
        facadeChecks.push(
          Object.isFrozen(ctx),
          raw.denials === undefined,
          raw.interactions === undefined,
          raw.preflights === undefined,
          raw.currentCandidate === undefined,
        );
        for (const key of ["denials", "interactions", "preflights"] as const) {
          (raw[key] as { clear?: () => void } | undefined)?.clear?.();
        }
        expect(() => {
          (raw as { currentCandidate?: unknown }).currentCandidate = { content: "replaced" };
        }).toThrow();
        const candidate = ctx.candidate() as { toolCalls?: { name: string }[] };
        expect(() => {
          candidate.toolCalls![0]!.name = "replacement";
        }).toThrow();
      },
    });
    const restrictions = defineMiddleware({
      id: "restrictions",
      beforeModel(ctx) {
        ctx.hideTools("hidden");
      },
      async aroundModel(ctx, next) {
        await next();
        ctx.denyTool("deny", "policy");
        ctx.requireInteraction("deny", { kind: "approval", prompt: "approve" });
        ctx.requirePreflight("deny", "validation");
      },
    });
    let step = 0;
    const result = Agent.create({
      model: model(async (request) => {
        if (++step > 1) return "done";
        expect(request.tools.map((item) => item.name)).toEqual(["echo"]);
        return {
          toolCalls: [
            { id: "hidden", name: "hidden", args: {} },
            { id: "deny", name: "echo", args: {} },
          ],
        };
      }),
      adapters: { local: adapter(execute) },
    })
      .with(
        defineCapability({
          id: "mw",
          middleware: [attacker, restrictions],
          setup: () => ({ tools: [tool("hidden"), tool("echo")] }),
        }),
      )
      .build();

    const { session, handle: streamed } = turn(result, "go");
    const output = (await streamed.completed).events;
    const toolEntry = session.state.transcript.find((entry) => entry.kind === "tool-results");

    expect(facadeChecks.every(Boolean)).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(toolEntry).toMatchObject({
      results: [
        { kind: "failed", code: "tool.hidden", callId: "hidden" },
        { kind: "denied", reason: "policy", callId: "deny" },
      ],
    });
    expect(output.at(-1)).toMatchObject({ type: "final", output: "done" });
  });

  it("rejects omitted, double, and deferred next calls", async () => {
    const invoke = vi.fn(async () => "done");
    let deferredError = "";
    let deferredMutationError = "";
    const cases = [
      defineMiddleware({ id: "omitted", async aroundModel() {} }),
      defineMiddleware({
        id: "double",
        async aroundModel(_ctx, next) {
          void next();
          await next();
        },
      }),
      defineMiddleware({
        id: "deferred",
        async aroundModel(ctx, next) {
          setTimeout(() => {
            try {
              void next();
            } catch (error) {
              deferredError = error instanceof Error ? error.message : String(error);
            }
            try {
              ctx.denyTool("late", "too late");
            } catch (error) {
              deferredMutationError = error instanceof Error ? error.message : String(error);
            }
          }, 0);
        },
      }),
    ];
    for (const middleware of cases) {
      const result = Agent.create({ model: model(invoke) })
        .with(defineCapability({ id: middleware.id, middleware: [middleware] }))
        .build();
      const output = (await turn(result, "go").handle.completed).events;
      expect(output).toMatchObject([
        { type: "tripwire", tripwire: { code: "middleware.around-failed" } },
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(deferredError).toMatch(/after returning/);
    expect(deferredMutationError).toMatch(/no longer active|sealed/);
  });

  it("copies context contributions before their source can mutate", async () => {
    const source = { type: "fixture", value: { nested: { value: 1 } } };
    const middleware = defineMiddleware({
      id: "context",
      beforeModel(ctx) {
        ctx.addContext(source);
        queueMicrotask(() => {
          source.value.nested.value = 9;
        });
      },
    });
    const result = Agent.create({
      model: model(async (request) => {
        expect(request.context).toEqual([{ type: "fixture", value: { nested: { value: 1 } } }]);
        expect(Object.isFrozen((request.context[0]?.value as { nested: object }).nested)).toBe(
          true,
        );
        return "done";
      }),
    })
      .with(defineCapability({ id: "context", middleware: [middleware] }))
      .build();
    await turn(result, "go").handle.completed;
  });
});
