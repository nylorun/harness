import { expect, it } from "vitest";
import {
  Agent,
  SANDBOX_INSTRUCTIONS,
  SANDBOX_TOOL_NAMES,
  createSandboxTools,
  hashManifest,
  isSandboxHostPattern,
  parseSandboxDuration,
  parseSandboxSize,
  tool,
} from "../src/define.js";
import { AgentManifestSchema } from "../src/contracts.js";
import { z } from "zod";

const sandboxCapability = (sandbox: Record<string, unknown> = {}) => ({
  id: "sandbox",
  instructions: [SANDBOX_INSTRUCTIONS],
  tools: createSandboxTools(),
  sandbox,
});

it("projects the sandbox config and six built-in tools into the manifest", () => {
  const built = Agent({ id: "analyst" })
    .use(sandboxCapability({ image: "python:3.13-slim", network: { preset: "dev" } }))
    .build();
  const capability = built.manifest.capabilities[0]!;
  expect(capability.sandbox).toEqual({ image: "python:3.13-slim", network: { preset: "dev" } });
  expect(capability.tools?.map((item) => item.name)).toEqual([...SANDBOX_TOOL_NAMES]);
  expect(AgentManifestSchema.safeParse(built.manifest).success).toBe(true);
});

it("keeps the hash stable across builds and round-trips through Agent.from", () => {
  const build = () =>
    Agent({ id: "analyst" }).use(sandboxCapability({ idle: "15m" })).build();
  const first = build();
  expect(hashManifest(first.manifest)).toBe(hashManifest(build().manifest));
  const json = JSON.parse(JSON.stringify(first.manifest));
  const tools = Object.fromEntries(createSandboxTools().map((item) => [item.name, item]));
  const restored = Agent.from(json, { sandbox: { tools } });
  expect(hashManifest(restored.manifest)).toBe(hashManifest(first.manifest));
  expect(restored.manifest.capabilities[0]?.sandbox).toEqual({ idle: "15m" });
});

it("changes the hash when sandbox requirements change", () => {
  const a = Agent({ id: "analyst" }).use(sandboxCapability()).build();
  const b = Agent({ id: "analyst" }).use(sandboxCapability({ image: "node:24" })).build();
  expect(hashManifest(a.manifest)).not.toBe(hashManifest(b.manifest));
});

it("rejects unknown fields, bad values and missing built-in tools on the wire", () => {
  const base = Agent({ id: "analyst" }).use(sandboxCapability()).build().manifest;
  const withSandbox = (sandbox: unknown) =>
    AgentManifestSchema.safeParse({
      ...base,
      capabilities: [{ ...base.capabilities[0], sandbox }],
    }).success;
  expect(withSandbox({ setup: ["pip install pandas"] })).toBe(false);
  expect(withSandbox({ idle: "soon" })).toBe(false);
  expect(withSandbox({ resources: { memory: "2GB" } })).toBe(false);
  expect(withSandbox({ network: { preset: "all" } })).toBe(false);
  expect(withSandbox({ network: { allow: ["https://api.github.com"] } })).toBe(false);
  expect(withSandbox({ network: { allow: ["*.github.com"] }, resources: { memory: "2GiB" } })).toBe(true);
  const missing = AgentManifestSchema.safeParse({
    ...base,
    capabilities: [
      {
        ...base.capabilities[0],
        tools: base.capabilities[0]!.tools!.filter((item) => item.name !== "bash"),
      },
    ],
  });
  expect(missing.success).toBe(false);
});

it("rejects two sandbox capabilities", () => {
  const base = Agent({ id: "analyst" }).use(sandboxCapability()).build().manifest;
  const result = AgentManifestSchema.safeParse({
    ...base,
    capabilities: [
      base.capabilities[0],
      { id: "second", type: "agent", sandbox: {} },
    ],
  });
  expect(result.success).toBe(false);
});

it("reports a collision when a developer tool reuses a built-in name", () => {
  const bash = tool({
    name: "bash",
    inputSchema: z.object({ command: z.string() }),
    async execute() {
      return "local";
    },
  });
  expect(() =>
    Agent({ id: "analyst", tools: [bash] }).use(sandboxCapability()).build()
  ).toThrow(/bash/);
});

it("fails the developer-process stub with a teaching error", async () => {
  const bash = createSandboxTools()[0]!;
  await expect((bash.execute as any)({ command: "ls" }, {})).rejects.toMatchObject({
    code: "sandbox.runtime-only",
  });
});

it("parses durations, sizes and host patterns", () => {
  expect(parseSandboxDuration("15m")).toBe(900_000);
  expect(parseSandboxDuration("0s")).toBeUndefined();
  expect(parseSandboxSize("2GiB")).toBe(2 * 1024 ** 3);
  expect(parseSandboxSize("2G")).toBeUndefined();
  expect(isSandboxHostPattern("api.github.com")).toBe(true);
  expect(isSandboxHostPattern("*.pythonhosted.org")).toBe(true);
  expect(isSandboxHostPattern("10.0.0.1")).toBe(false);
  expect(isSandboxHostPattern("localhost")).toBe(false);
  expect(isSandboxHostPattern("github.com/foo")).toBe(false);
});
