import { z } from "zod";
import { describe, expect, it } from "vitest";
import { Agent, defineCapability, defineTool } from "../src/index.js";
import { adapter, expectBuildError, model, turn } from "./fixtures.js";

describe("Zod schemas", () => {
  it("executes a tool with Zod's parsed object output", async () => {
    let call = 0;
    let executed: unknown;
    const result = Agent.create({
      model: model(async () => {
        call += 1;
        return call === 1
          ? { toolCalls: [{ id: "convert", name: "convert", args: { count: "2" } }] }
          : "done";
      }),
      adapters: {
        local: adapter(async (toolCall) => {
          executed = toolCall.args;
          return { kind: "completed", output: toolCall.args };
        }),
      },
    })
      .with(
        defineCapability({
          id: "parsed",
          setup: () => ({
            tools: [
              defineTool({
                name: "convert",
                input: z.object({ count: z.coerce.number() }),
                executeWith: "local",
                route: {},
              }),
            ],
          }),
        }),
      )
      .build();

    await turn(result, "go").handle.completed;
    expect(executed).toEqual({ count: 2 });
  });

  it("binds a Zod object and publishes its JSON Schema", async () => {
    const input = z.object({ text: z.string() });
    const result = Agent.create({
      model: model(async () => "done"),
      adapters: { local: adapter() },
    })
      .with(
        defineCapability({
          id: "zod",
          setup: () => ({
            tools: [defineTool({ name: "echo", input, executeWith: "local", route: {} })],
          }),
        }),
      )
      .build();

    expect(result.manifest.tools[0]?.jsonSchema).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
    });
  });

  it("rejects a non-object Zod root at build", () => {
    const error = expectBuildError(() =>
      Agent.create({
        model: model(async () => "done"),
        adapters: { local: adapter() },
      })
        .with(
          defineCapability({
            id: "bad",
            setup: () => ({
              tools: [
                defineTool({
                  name: "bad",
                  input: z.string() as never,
                  executeWith: "local",
                  route: {},
                }),
              ],
            }),
          }),
        )
        .build(),
    );
    expect(error.diagnostics[0]?.code).toBe("tool.invalid");
  });

  it("rejects declared asynchronous Zod checks at build", () => {
    const input = z.object({ text: z.string() }).refine(async () => true);
    const error = expectBuildError(() =>
      Agent.create({
        model: model(async () => "done"),
        adapters: { local: adapter() },
      })
        .with(
          defineCapability({
            id: "async",
            setup: () => ({
              tools: [defineTool({ name: "async", input, executeWith: "local", route: {} })],
            }),
          }),
        )
        .build(),
    );
    expect(error.diagnostics[0]?.message).toContain("validate synchronously");
  });

  it("rejects a Zod object that cannot convert to JSON Schema", () => {
    const error = expectBuildError(() =>
      Agent.create({
        model: model(async () => "done"),
        adapters: { local: adapter() },
      })
        .with(
          defineCapability({
            id: "unconvertible",
            setup: () => ({
              tools: [
                defineTool({
                  name: "bigint",
                  input: z.object({ value: z.bigint() }),
                  executeWith: "local",
                  route: {},
                }),
              ],
            }),
          }),
        )
        .build(),
    );
    expect(error.diagnostics[0]?.code).toBe("tool.invalid");
    expect(error.diagnostics[0]?.message).toContain("convert to JSON Schema");
  });

  it("seals invalid Zod arguments as tool.invalid-arguments", async () => {
    let call = 0;
    const result = Agent.create({
      model: model(async () => {
        call += 1;
        return call === 1
          ? { toolCalls: [{ id: "echo", name: "echo", args: { text: 1 } }] }
          : "done";
      }),
      adapters: { local: adapter() },
    })
      .with(
        defineCapability({
          id: "typed",
          setup: () => ({
            tools: [
              defineTool({
                name: "echo",
                input: z.object({ text: z.string() }),
                executeWith: "local",
                route: {},
              }),
            ],
          }),
        }),
      )
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
