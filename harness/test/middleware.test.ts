import { describe, expect, it, vi } from "vitest";
import { Agent } from "../src/index.js";
import { adapter, offer, model, tool, toolCalls, turn } from "./fixtures.js";

describe("middleware", () => {
  it("runs as an outward-to-inward request onion and inward-to-outward response onion", async () => {
    const order: string[] = [];
    const result = Agent(
      model(async (request) => {
        order.push(`model:${request.instructions.at(-1)}`);
        return "done";
      }),
    )
      .with(adapter())
      .use("one", async (request, next) => {
        order.push("enter-one");
        request.instructions.add("extra");
        const response = await next();
        order.push("exit-one");
        return response;
      })
      .use("two", async (_request, next) => {
        order.push("enter-two");
        const response = await next();
        order.push("exit-two");
        return response;
      })
      .build();
    await turn(result, "go").handle.completed;
    expect(order).toEqual(["enter-one", "enter-two", "model:extra", "exit-two", "exit-one"]);
  });

  it("tripwires conflicting model selection", async () => {
    const result = Agent(model(async () => "done"))
      .use("a", async (request, next) => {
        request.model.select({ id: "haiku" });
        return next();
      })
      .use("b", async (request, next) => {
        request.model.select({ id: "opus" });
        return next();
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "tripwire", tripwire: { code: "model.selection-conflict" } },
    ]);
  });

  it("keeps Step restrictions and the candidate behind frozen branded facades", async () => {
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "unexpected" }));
    const facadeChecks: boolean[] = [];
    let step = 0;
    const result = Agent(
      model(async (request) => {
        if (++step > 1) return "done";
        expect(request.tools.map((item) => item.name)).toEqual(["echo"]);
        return toolCalls(
          { id: "hidden", name: "hidden", args: {} },
          { id: "deny", name: "echo", args: {} },
        );
      }),
    )
      .with(adapter(execute))
      .use("attacker", async (request, next) => {
        const raw = request as unknown as Record<string, unknown>;
        facadeChecks.push(Object.isFrozen(request), raw.hiddenTools === undefined);
        const response = await next();
        const responseRaw = response as unknown as Record<string, unknown>;
        facadeChecks.push(
          Object.isFrozen(response),
          responseRaw.denials === undefined,
          responseRaw.currentCandidate === undefined,
        );
        const candidate = response.candidate();
        const first = candidate?.output[0] as { name?: string } | undefined;
        expect(() => {
          first!.name = "replacement";
        }).toThrow();
        return response;
      })
      .use("restrictions", async (request, next) => {
        request.tools.add(tool("hidden"), tool("echo"));
        request.tools.hide("hidden");
        const response = await next();
        response.deny("deny", "policy");
        response.requireInteraction("deny", { kind: "approval", prompt: "approve" });
        response.requirePreflight("deny", "validation");
        return response;
      })
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

  it("rejects omitted, double, and forged next returns as session tripwires", async () => {
    const invoke = vi.fn(async () => "done");
    const omitted = Agent(model(invoke))
      .use("omitted", async () => undefined as never)
      .build();
    expect((await turn(omitted, "go").handle.completed).events).toMatchObject([
      { type: "tripwire", tripwire: { code: "middleware.invalid-response" } },
    ]);

    const doubled = Agent(model(invoke))
      .use("double", async (_request, next) => {
        void next();
        return next();
      })
      .build();
    await expect(turn(doubled, "go").handle.completed).resolves.toMatchObject({
      events: [{ type: "tripwire", tripwire: { code: "middleware.next-called-twice" } }],
    });
    expect(doubled.run().state.status).toBe("idle");
  });

  it("copies context contributions before their source can mutate", async () => {
    const source = { type: "fixture", value: { nested: { value: 1 } } };
    const result = Agent(
      model(async (request) => {
        expect(request.context).toEqual([{ type: "fixture", value: { nested: { value: 1 } } }]);
        expect(Object.isFrozen((request.context[0]?.value as { nested: object }).nested)).toBe(
          true,
        );
        return "done";
      }),
    )
      .use("context", async (request, next) => {
        request.context.add(source);
        queueMicrotask(() => {
          source.value.nested.value = 9;
        });
        return next();
      })
      .build();
    await turn(result, "go").handle.completed;
  });

  it("offers tools only for the Step that added them", async () => {
    let step = 0;
    const seen: string[][] = [];
    const result = Agent(
      model(async (request) => {
        seen.push(request.tools.map((item) => item.name));
        return ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
      }),
    )
      .with(adapter())
      .use("test", offer(tool()))
      .build();
    await turn(result, "go").handle.completed;
    expect(seen).toEqual([["echo"], ["echo"]]);
  });

  it("forwards a selected model directive and omits it when nobody selects", async () => {
    const seen: unknown[] = [];
    const selected = Agent(
      model(async (request) => {
        seen.push(request.model);
        return "done";
      }),
    )
      .use("route", async (request, next) => {
        request.model.select({
          id: "opus",
          controls: { temperature: 0.2, maxOutputTokens: 128 },
          config: { reasoning: "high" },
        });
        return next();
      })
      .build();
    await turn(selected, "go").handle.completed;
    expect(seen).toEqual([
      {
        id: "opus",
        controls: { temperature: 0.2, maxOutputTokens: 128 },
        config: { reasoning: "high" },
      },
    ]);

    seen.length = 0;
    const omitted = Agent(
      model(async (request) => {
        seen.push(request.model);
        return "done";
      }),
    ).build();
    await turn(omitted, "go").handle.completed;
    expect(seen).toEqual([undefined]);
  });

  it("treats select({}) as an explicit empty directive and allows an identical select", async () => {
    const seen: unknown[] = [];
    const result = Agent(
      model(async (request) => {
        seen.push(request.model);
        return "done";
      }),
    )
      .use("outer", async (request, next) => {
        request.model.select({ id: undefined });
        return next();
      })
      .use("inner", async (request, next) => {
        request.model.select({});
        return next();
      })
      .build();
    await turn(result, "go").handle.completed;
    expect(seen).toEqual([{}]);
  });

  it("tripwires a partial-merge select and invalid directives", async () => {
    const merge = Agent(model(async () => "done"))
      .use("id", async (request, next) => {
        request.model.select({ id: "haiku" });
        return next();
      })
      .use("config", async (request, next) => {
        request.model.select({ config: { reasoning: "high" } });
        return next();
      })
      .build();
    expect((await turn(merge, "go").handle.completed).events).toMatchObject([
      { type: "tripwire", tripwire: { code: "model.selection-conflict" } },
    ]);

    const unknownKey = Agent(model(async () => "done"))
      .use("bad", async (request, next) => {
        request.model.select({ id: "haiku", extra: true } as never);
        return next();
      })
      .build();
    expect((await turn(unknownKey, "go").handle.completed).events).toMatchObject([
      { type: "tripwire", tripwire: { code: "model.invalid-directive" } },
    ]);

    const emptyId = Agent(model(async () => "done"))
      .use("empty", async (request, next) => {
        request.model.select({ id: "" });
        return next();
      })
      .build();
    expect((await turn(emptyId, "go").handle.completed).events).toMatchObject([
      { type: "tripwire", tripwire: { code: "model.invalid-directive" } },
    ]);

    const unknownControl = Agent(model(async () => "done"))
      .use("bad-control", async (request, next) => {
        request.model.select({ controls: { topP: 0.5 } } as never);
        return next();
      })
      .build();
    expect((await turn(unknownControl, "go").handle.completed).events).toMatchObject([
      { type: "tripwire", tripwire: { code: "model.invalid-directive" } },
    ]);
  });

  it("deep-copies and freezes directive config so source mutation cannot leak in", async () => {
    const source = { reasoning: "low", nested: { n: 1 } };
    const result = Agent(
      model(async (request) => {
        expect(request.model?.config).toEqual({ reasoning: "low", nested: { n: 1 } });
        expect(Object.isFrozen(request.model?.config)).toBe(true);
        expect(Object.isFrozen((request.model?.config as { nested: object }).nested)).toBe(true);
        return "done";
      }),
    )
      .use("route", async (request, next) => {
        request.model.select({ id: "haiku", config: source });
        source.nested.n = 9;
        source.reasoning = "high";
        return next();
      })
      .build();
    await turn(result, "go").handle.completed;
  });

  it("exposes a frozen pre-call transcript and starts the next Step without a prior directive", async () => {
    const seen: Array<{ model?: unknown; transcriptKinds: string[] }> = [];
    const result = Agent(
      model(async (request) => {
        seen.push({
          model: request.model,
          transcriptKinds: request.transcript.map((entry) => entry.kind),
        });
        return seen.length === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
      }),
    )
      .with(adapter())
      .use("route", async (request, next) => {
        expect(Object.isFrozen(request.transcript)).toBe(true);
        expect(() => {
          (request.transcript as { kind: string }[]).push({ kind: "forged" });
        }).toThrow();
        if (request.stepNumber === 1) request.model.select({ id: "haiku" });
        return next();
      })
      .use("test", offer(tool()))
      .build();
    await turn(result, "go").handle.completed;
    expect(seen).toEqual([
      { model: { id: "haiku" }, transcriptKinds: ["input"] },
      { model: undefined, transcriptKinds: ["input", "candidate", "tool-results"] },
    ]);
  });

  it("revokes model.select after next() without stopping a settled Session", async () => {
    const observed: string[] = [];
    let lateError = "";
    const result = Agent(model(async () => "done"))
      .use("late", async (request, next) => {
        const response = await next();
        try {
          request.model.select({ id: "opus" });
        } catch (error) {
          lateError = error instanceof Error ? error.message : String(error);
        }
        return response;
      })
      .build();
    const session = result.run();
    session.observe((event) => observed.push(event.type));
    await session.input("go").completed;
    expect(lateError).toMatch(/no longer active/);
    expect(observed).toContain("middleware.lease-violation");
    expect(session.state.status).toBe("idle");
    await session.stop();
  });
});
