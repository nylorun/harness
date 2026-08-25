import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { Agent, defineTool } from "../src/index.js";
import { adapter, model, toolCalls, turn } from "./fixtures.js";

describe("Zod schemas", () => {
  it("executes a tool with Zod's parsed object output", async () => {
    let call = 0;
    let executed: unknown;
    const convert = defineTool({
      name: "convert",
      input: z.object({ count: z.coerce.number() }),
      executeWith: "local",
      route: {},
    });
    const result = Agent(
      model(async () => {
        call += 1;
        return call === 1
          ? toolCalls({ id: "convert", name: "convert", args: { count: "2" } })
          : "done";
      }),
    )
      .with(
        adapter(async (toolCall) => {
          executed = toolCall.args;
          return { kind: "completed", output: toolCall.args };
        }),
      )
      .use("parsed", async (request, next) => {
        request.tools.add(convert);
        return next();
      })
      .build();

    await turn(result, "go").handle.completed;
    expect(executed).toEqual({ count: 2 });
  });

  it("binds a Zod object onto the offered Model request", async () => {
    const input = z.object({ text: z.string() });
    const echo = defineTool({ name: "echo", input, executeWith: "local", route: {} });
    const result = Agent(
      model(async (request) => {
        expect(request.tools[0]?.input.jsonSchema).toMatchObject({
          type: "object",
          properties: { text: { type: "string" } },
        });
        return "done";
      }),
    )
      .with(adapter())
      .use("zod", async (request, next) => {
        request.tools.add(echo);
        return next();
      })
      .build();

    await turn(result, "go").handle.completed;
  });

  it("tripwires a non-object Zod root before the Model runs", async () => {
    const invoke = vi.fn(async () => "done");
    const result = Agent(model(invoke))
      .with(adapter())
      .use("bad", async (request, next) => {
        request.tools.add(
          defineTool({
            name: "bad",
            input: z.string() as never,
            executeWith: "local",
            route: {},
          }),
        );
        return next();
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([{ type: "tripwire", tripwire: { code: "tool.invalid" } }]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tripwires declared asynchronous Zod checks before the Model runs", async () => {
    const invoke = vi.fn(async () => "done");
    const input = z.object({ text: z.string() }).refine(async () => true);
    const result = Agent(model(invoke))
      .with(adapter())
      .use("async", async (request, next) => {
        request.tools.add(defineTool({ name: "async", input, executeWith: "local", route: {} }));
        return next();
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output[0]).toMatchObject({ type: "tripwire", tripwire: { code: "tool.invalid" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tripwires a Zod object that cannot convert to JSON Schema before the Model runs", async () => {
    const invoke = vi.fn(async () => "done");
    const result = Agent(model(invoke))
      .with(adapter())
      .use("unconvertible", async (request, next) => {
        request.tools.add(
          defineTool({
            name: "bigint",
            input: z.object({ value: z.bigint() }),
            executeWith: "local",
            route: {},
          }),
        );
        return next();
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output[0]).toMatchObject({ type: "tripwire", tripwire: { code: "tool.invalid" } });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("seals invalid Zod arguments as tool.invalid-arguments", async () => {
    let call = 0;
    const result = Agent(
      model(async () => {
        call += 1;
        return call === 1 ? toolCalls({ id: "echo", name: "echo", args: { text: 1 } }) : "done";
      }),
    )
      .with(adapter())
      .use("typed", async (request, next) => {
        request.tools.add(
          defineTool({
            name: "echo",
            input: z.object({ text: z.string() }),
            executeWith: "local",
            route: {},
          }),
        );
        return next();
      })
      .build();

    const { session, handle } = turn(result, "go");
    await handle.completed;
    const entry = session.state.transcript.find((item) => item.kind === "tool-results");
    expect(entry?.kind).toBe("tool-results");
    if (entry?.kind === "tool-results") {
      expect(entry.results).toEqual([
        expect.objectContaining({
          callId: "echo",
          kind: "failed",
          code: "tool.invalid-arguments",
        }),
      ]);
    }
  });
});
