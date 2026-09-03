import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineSchema, type ModelCall, type ObserveEvent } from "../src/index.js";
import { testAgent, model, offer, tool, toolCalls } from "./fixtures.js";

const resultSchema = z.object({ summary: z.string(), count: z.number() });

describe("structured terminal output", () => {
  it("projects one immutable schema through a tool loop and seals the validated JSON result", async () => {
    const calls: ModelCall[] = [];
    let step = 0;
    const session = testAgent()
      .use("tools", offer(tool("lookup")))
      .with(
        model(async (call) => {
          calls.push(call);
          return ++step === 1
            ? toolCalls({ id: "lookup", name: "lookup", args: {} })
            : { output: [{ type: "json", value: { summary: "done", count: 2 } }] };
        }),
      )
      .build()
      .run();

    const completion = await session.input("go", { outputSchema: resultSchema }).completed;
    expect(completion.events.at(-1)).toEqual({
      type: "final",
      turnId: expect.any(String),
      output: { summary: "done", count: 2 },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.outputSchema?.type === "object")).toBe(true);
    expect(Object.isFrozen(calls[0]!.outputSchema)).toBe(true);
    const final = session.state.transcript.at(-1);
    expect(final).toMatchObject({ kind: "final", output: { summary: "done", count: 2 } });
  });

  it("does not parse text and trips after preserving the canonical candidate", async () => {
    const observed: ObserveEvent[] = [];
    const session = testAgent()
      .with(
        model(async () => ({ output: [{ type: "text", text: '{"summary":"done","count":2}' }] })),
      )
      .build()
      .run();
    session.observe((event) => observed.push(event));

    const completion = await session.input("go", { outputSchema: resultSchema }).completed;
    expect(completion.events).toMatchObject([
      { type: "input" },
      { type: "candidate", candidate: { output: [{ type: "text" }] } },
      { type: "tripwire", tripwire: { code: "output.invalid" } },
    ]);
    expect(observed.map((event) => event.type)).toContain("model.completed");
    expect(observed.map((event) => event.type)).toContain("tripwire");
    expect(observed.map((event) => event.type).indexOf("model.completed")).toBeLessThan(
      observed.map((event) => event.type).indexOf("tripwire"),
    );
  });

  it("validates middleware replacements at the terminal seam", async () => {
    const session = testAgent()
      .use("review", async (_request, next) => {
        const response = await next();
        response.replace({ output: [{ type: "json", value: { summary: "reviewed", count: 1 } }] });
        return response;
      })
      .with(
        model(async () => ({ output: [{ type: "json", value: { summary: 1, count: "bad" } }] })),
      )
      .build()
      .run();

    const completion = await session.input("go", { outputSchema: resultSchema }).completed;
    expect(completion.events.at(-1)).toMatchObject({
      type: "final",
      output: { summary: "reviewed", count: 1 },
    });
  });

  it("seeds structured finals and JSON candidates immutably", () => {
    const candidate = { output: [{ type: "json" as const, value: { count: 1 } }] };
    const transcript = [
      { kind: "candidate" as const, turnId: "turn", stepId: "step", candidate },
      { kind: "final" as const, turnId: "turn", stepId: "step", output: { count: 1 } },
    ];
    const session = testAgent()
      .with(model(async () => "done"))
      .build()
      .run({ seed: { transcript } });
    candidate.output[0]!.value.count = 9;
    expect(session.state.transcript).toMatchObject([
      { kind: "candidate", candidate: { output: [{ type: "json", value: { count: 1 } }] } },
      { kind: "final", output: { count: 1 } },
    ]);
  });

  it("binds explicit and Standard Schema output contracts through the existing schema seam", async () => {
    const jsonSchema = { type: "object", properties: { ok: { type: "boolean" } } } as const;
    const explicit = defineSchema({
      jsonSchema,
      validate(value) {
        return typeof (value as { ok?: unknown })?.ok === "boolean"
          ? { ok: true as const, value: value as { ok: boolean } }
          : { ok: false as const, issues: [{ path: [], code: "invalid", message: "Expected ok" }] };
      },
    });
    const standard = {
      "~standard": {
        validate(value: unknown) {
          return typeof (value as { ok?: unknown })?.ok === "boolean"
            ? { value: value as { ok: boolean } }
            : { issues: [{ message: "Expected ok" }] };
        },
        jsonSchema: { input: () => jsonSchema, output: () => jsonSchema },
      },
    };
    const agent = testAgent()
      .with(model(async () => ({ output: [{ type: "json", value: { ok: true } }] })))
      .build();

    expect(
      (await agent.run().input("go", { outputSchema: explicit }).completed).events.at(-1),
    ).toMatchObject({
      type: "final",
      output: { ok: true },
    });
    expect(
      (await agent.run().input("go", { outputSchema: standard }).completed).events.at(-1),
    ).toMatchObject({
      type: "final",
      output: { ok: true },
    });
  });
});
