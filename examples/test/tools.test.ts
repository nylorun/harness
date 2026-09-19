import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Agent,
  model,
  type CapabilityItems,
  type ToolDefinition,
} from "@nylorun/harness";
import { afterEach, describe, expect, it } from "vitest";
import { tools } from "../agents/shared/tools/index.js";
import { invokeTool } from "./support.js";

const adapter = model(async () => ({
  output: [{ type: "text" as const, text: "ok" }],
  finishReason: "stop" as const,
}));

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(
    temps.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

function items<T>(value: CapabilityItems<T> | undefined): readonly T[] {
  if (value === undefined) return [];
  return "items" in value ? value.items : value;
}

function catalogTool(
  name: string,
  declaration: Awaited<ReturnType<typeof tools>>
): ToolDefinition {
  const found = items(declaration.tools).find((tool) => tool.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

describe("tools()", () => {
  it("loads calculate from the tools catalog", async () => {
    const declaration = await tools();
    await expect(
      invokeTool(catalogTool("calculate", declaration), {
        expression: "19 * 7",
      })
    ).resolves.toEqual({
      kind: "completed",
      output: { expression: "19 * 7", value: 133 },
    });
  });

  it("converts compatible units and rejects incompatible ones", async () => {
    const declaration = await tools();
    const convert = catalogTool("convert", declaration);
    await expect(
      invokeTool(convert, { value: 25, from: "celsius", to: "fahrenheit" })
    ).resolves.toEqual({
      kind: "completed",
      output: { value: 25, from: "celsius", to: "fahrenheit", result: 77 },
    });
    await expect(
      invokeTool(convert, { value: 1, from: "celsius", to: "meter" })
    ).resolves.toEqual({
      kind: "failed",
      code: "convert.incompatible",
      message: "Cannot convert celsius to meter.",
    });
  });

  it("returns UTC iso and unixMs from now", async () => {
    const declaration = await tools();
    const result = await invokeTool(catalogTool("now", declaration), {});
    expect(result).toMatchObject({
      kind: "completed",
      output: {
        iso: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
        unixMs: expect.any(Number),
      },
    });
  });

  it("omits tools when the directory has no catalog modules", async () => {
    const root = await mkdtemp(join(tmpdir(), "tools-test-"));
    temps.push(root);
    await expect(tools({ directory: root })).resolves.toEqual({ id: "tools" });
  });

  it("builds the tool-use agent with one tools middleware", async () => {
    const agent = Agent({
      id: "tool-use",
      name: "Tool Use",
      instructions: "Be concise.",
    })
      .use(await tools())
      .build();
    expect(agent.manifest.capabilities.map((item) => item.id)).toEqual([
      "agent",
      "tools",
    ]);
    const offered =
      agent.manifest.capabilities.find((item) => item.id === "tools")?.tools ??
      [];
    expect(offered.map((tool) => tool.name).sort()).toEqual([
      "calculate",
      "convert",
      "now",
    ]);
  });
});
