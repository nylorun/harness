import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { Agent, tool } from "../src/index.js";
import { adapter, model, toolCalls, turn } from "./fixtures.js";

describe("Zod schemas", () => {
  it("executes a tool with Zod's parsed object output", async () => {
    let call = 0;
    let executed: unknown;
    const convert = tool({
      name: "convert",
      parameters: z.object({ count: z.coerce.number() }),
      executeWith: "local",
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
        request.prefix.tools.set("parsed", [convert]);
        return next();
      })
      .build();

    await turn(result, "go").handle.completed;
    expect(executed).toEqual({ count: 2 });
  });

  it("binds a Zod object onto the offered Model request", async () => {
    const parameters = z.object({ text: z.string() });
    const echo = tool({ name: "echo", parameters, executeWith: "local" });
    const result = Agent(
      model(async (_call, { request }) => {
        expect(request.tools[0]?.parameters.jsonSchema).toMatchObject({
          type: "object",
          properties: { text: { type: "string" } },
        });
        return "done";
      }),
    )
      .with(adapter())
      .use("zod", async (request, next) => {
        request.prefix.tools.set("zod", [echo]);
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
        request.prefix.tools.set("bad", [
          tool({
            name: "bad",
            parameters: z.string() as never,
            executeWith: "local",
          }),
        ]);
        return next();
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "tool.invalid-schema" } },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tripwires declared asynchronous Zod checks before the Model runs", async () => {
    const invoke = vi.fn(async () => "done");
    const parameters = z.object({ text: z.string() }).refine(async () => true);
    const result = Agent(model(invoke))
      .with(adapter())
      .use("async", async (request, next) => {
        request.prefix.tools.set("async", [
          tool({ name: "async", parameters, executeWith: "local" }),
        ]);
        return next();
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "tool.invalid-schema" } },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("tripwires a Zod object that cannot convert to JSON Schema before the Model runs", async () => {
    const invoke = vi.fn(async () => "done");
    const result = Agent(model(invoke))
      .with(adapter())
      .use("unconvertible", async (request, next) => {
        request.prefix.tools.set("unconvertible", [
          tool({
            name: "bigint",
            parameters: z.object({ value: z.bigint() }),
            executeWith: "local",
          }),
        ]);
        return next();
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "tool.invalid-schema" } },
    ]);
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
        request.prefix.tools.set("typed", [
          tool({
            name: "echo",
            parameters: z.object({ text: z.string() }),
            executeWith: "local",
          }),
        ]);
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
