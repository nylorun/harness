import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { Agent, tool } from "../src/index.js";
import { normalizedSchemaFor } from "../src/build/schema.js";
import { model, toolCalls, turn } from "./fixtures.js";

describe("Zod schemas", () => {
  it("executes a tool with Zod's parsed object output", async () => {
    let call = 0;
    let executed: unknown;
    const convert = tool({
      name: "convert",
      parameters: z.object({ count: z.coerce.number() }),
      async execute(args) {
        executed = args;
        return { kind: "completed", output: args };
      },
    });
    const result = Agent(
      model(async () => {
        call += 1;
        return call === 1
          ? toolCalls({ id: "convert", name: "convert", args: { count: "2" } })
          : "done";
      }),
    )
      .use("parsed", async (request, next) => {
        request.configuration.tools.set("parsed", [convert]);
        return next();
      })
      .build();

    await turn(result, "go").handle.completed;
    expect(executed).toEqual({ count: 2 });
  });

  it("binds a Zod object onto the offered Model request", async () => {
    const parameters = z.object({ text: z.string() });
    const echo = tool({
      name: "echo",
      parameters,
      async execute(args) {
        return { kind: "completed", output: args };
      },
    });
    const result = Agent(
      model(async (_call, { request }) => {
        expect(request.tools[0]?.parameters.jsonSchema).toMatchObject({
          type: "object",
          properties: { text: { type: "string" } },
        });
        return "done";
      }),
    )
      .use("zod", async (request, next) => {
        request.configuration.tools.set("zod", [echo]);
        return next();
      })
      .build();

    await turn(result, "go").handle.completed;
  });

  it("prepares authored and raw schemas once across repeated step declarations", async () => {
    const prepared = tool({
      name: "prepared",
      parameters: z.object({ value: z.string() }),
      async execute(args) {
        return { kind: "completed", output: args };
      },
    });
    const raw = {
      name: "raw",
      parameters: z.object({ value: z.string() }),
      async execute(args: { value: string }) {
        return { kind: "completed" as const, output: args };
      },
    };
    let calls = 0;
    const result = Agent(
      model(async () => {
        calls += 1;
        return calls === 1
          ? toolCalls({ id: "prepared", name: "prepared", args: { value: "x" } })
          : "done";
      }),
    )
      .use("tools", async (request, next) => {
        request.configuration.tools.set("tools", [prepared, raw]);
        return next();
      })
      .build();

    await turn(result, "go").handle.completed;
    expect(normalizedSchemaFor(prepared)).toBe(normalizedSchemaFor(prepared));
    expect(normalizedSchemaFor(raw)).toBe(normalizedSchemaFor(raw));
  });

  it("rejects invalid authored schemas when tool() defines them", () => {
    expect(() =>
      tool({
        name: "bad",
        parameters: z.string() as never,
        async execute() {
          return { kind: "completed", output: null };
        },
      }),
    ).toThrow(/Zod object schema/);
  });

  it("tripwires an invalid raw tool literal when it is first bound", async () => {
    const invoke = vi.fn(async () => "done");
    const result = Agent(model(invoke))
      .use("bad", async (request, next) => {
        request.configuration.tools.set("bad", [
          {
            name: "bad",
            parameters: z.string() as never,
            async execute() {
              return { kind: "completed" as const, output: null };
            },
          },
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
      .use("async", async (request, next) => {
        request.configuration.tools.set("async", [
          tool({
            name: "async",
            parameters,
            async execute(args) {
              return { kind: "completed", output: args };
            },
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

  it("tripwires a Zod object that cannot convert to JSON Schema before the Model runs", async () => {
    const invoke = vi.fn(async () => "done");
    const result = Agent(model(invoke))
      .use("unconvertible", async (request, next) => {
        request.configuration.tools.set("unconvertible", [
          tool({
            name: "bigint",
            parameters: z.object({ value: z.bigint() }),
            async execute() {
              return { kind: "completed", output: null };
            },
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
      .use("typed", async (request, next) => {
        request.configuration.tools.set("typed", [
          tool({
            name: "echo",
            parameters: z.object({ text: z.string() }),
            async execute(args) {
              return { kind: "completed", output: args };
            },
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
