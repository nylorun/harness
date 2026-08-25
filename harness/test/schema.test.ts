import { z } from "zod";
import { describe, expect, it } from "vitest";
import { Harness, defineCapability, defineTool } from "../src/index.js";
import { adapter, model, turn } from "./fixtures.js";

describe("Zod schemas", () => {
  it("executes a tool with Zod's parsed object output", async () => {
    let call = 0;
    let executed: unknown;
    const result = await new Harness({
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
      .add(
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
    if (!result.ok) throw new Error("build failed");

    await turn(result.agent, "go").handle.completed;
    expect(executed).toEqual({ count: 2 });
  });

  it("binds a Zod object and publishes its JSON Schema", async () => {
    const input = z.object({ text: z.string() });
    const result = await new Harness({
      model: model(async () => "done"),
      adapters: { local: adapter() },
    })
      .add(
        defineCapability({
          id: "zod",
          setup: () => ({
            tools: [defineTool({ name: "echo", input, executeWith: "local", route: {} })],
          }),
        }),
      )
      .build();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.tools[0]?.jsonSchema).toMatchObject({
        type: "object",
        properties: { text: { type: "string" } },
      });
    }
  });

  it("rejects a non-object Zod root at build", async () => {
    const result = await new Harness({
      model: model(async () => "done"),
      adapters: { local: adapter() },
    })
      .add(
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
      .build();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics[0]?.code).toBe("tool.invalid");
  });

  it("rejects declared asynchronous Zod checks at build", async () => {
    const input = z.object({ text: z.string() }).refine(async () => true);
    const result = await new Harness({
      model: model(async () => "done"),
      adapters: { local: adapter() },
    })
      .add(
        defineCapability({
          id: "async",
          setup: () => ({
            tools: [defineTool({ name: "async", input, executeWith: "local", route: {} })],
          }),
        }),
      )
      .build();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics[0]?.message).toContain("validate synchronously");
  });

  it("rejects a Zod object that cannot convert to JSON Schema", async () => {
    const result = await new Harness({
      model: model(async () => "done"),
      adapters: { local: adapter() },
    })
      .add(
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
      .build();

    expect(result.ok).toBe(false);
    expect(!result.ok && result.diagnostics[0]?.code).toBe("tool.invalid");
    expect(!result.ok && result.diagnostics[0]?.message).toContain("convert to JSON Schema");
  });

  it("seals invalid Zod arguments as tool.invalid-arguments", async () => {
    let call = 0;
    const result = await new Harness({
      model: model(async () => {
        call += 1;
        return call === 1
          ? { toolCalls: [{ id: "echo", name: "echo", args: { text: 1 } }] }
          : "done";
      }),
      adapters: { local: adapter() },
    })
      .add(
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
    if (!result.ok) throw new Error("build failed");

    const { session, handle } = turn(result.agent, "go");
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
