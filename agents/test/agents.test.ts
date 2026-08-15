import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";
import { Agent, buildAgent, validateAgent } from "../src/index.js";

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylo-agents-"));
  await mkdir(join(root, "agent"), { recursive: true });
  await mkdir(join(root, "node_modules", "@nylorun"), { recursive: true });
  await symlink(new URL("../", import.meta.url).pathname, join(root, "node_modules", "@nylorun", "agents"), "dir");
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(root, "vite.config.ts"), `import { nyloAgent } from "@nylorun/agents";\nexport default {plugins:[nyloAgent()]};\n`);
  await writeFile(join(root, "agent", "agent.ts"), `import { Agent } from "@nylorun/agents";\nexport default Agent({name:"sample",model:"anthropic/example"});\n`);
  await writeFile(join(root, "agent", "AGENT.md"), "You are helpful.\n");
  return root;
}

describe("Agent", () => {
  // The barrel is the review artifact: every name here is a semver commitment, so this list is
  // meant to be edited deliberately rather than updated to make a build pass.
  it("keeps the runtime export barrel reviewed", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      // Authoring and build
      "Agent", "buildAgent", "createFilesystemReader", "defineTool",
      "isModelIdentity", "isPortableName", "nyloAgent", "validateAgent",
      // The session loop, shared with the Agent Runtime
      "OPENROUTER_VARIABLE", "OpenAICompatibleProvider", "ProviderError",
      "SESSION_EVENT_TYPES", "SKILL_TOOL_NAME", "createSession", "fold",
      "initialState", "openAgent", "rehydrate",
      "resolveCredential", "resolveModel"
    ].sort());
  });
  it("normalizes optional collections", () => {
    expect(Agent({ name: "sample", model: "anthropic/example" })).toMatchObject({ secrets: [], mcp: [] });
  });
});

describe("validation", () => {
  it("distinguishes reserved and unknown components", async () => {
    const root = await project();
    await mkdir(join(root, "agent", "memory"));
    await mkdir(join(root, "agent", "mystery"));
    const result = await validateAgent(root);
    expect(result.diagnostics.map((item) => item.code)).toContain("NYLO_CHECK_COMPONENT_RESERVED");
    expect(result.diagnostics.map((item) => item.code)).toContain("NYLO_CHECK_COMPONENT_UNKNOWN");
  });

  it("does not import the definition", async () => {
    const root = await project();
    await writeFile(join(root, "agent", "agent.ts"), `await import("node:fs").then(({writeFileSync})=>writeFileSync(${JSON.stringify(join(root, "side-effect"))},"bad"));`);
    const result = await validateAgent(root);
    expect(result.ok).toBe(true);
    await expect(readFile(join(root, "side-effect"))).rejects.toThrow();
  });

  it("refuses all reserved components separately from unknown paths", async () => {
    const root = await project();
    for (const path of ["evals", "agent/memory", "agent/subagents"]) await mkdir(join(root, path));
    const result = await validateAgent(root);
    expect(result.diagnostics.filter((item) => item.code === "NYLO_CHECK_COMPONENT_RESERVED")).toHaveLength(3);
    expect(result.diagnostics.some((item) => item.code === "NYLO_CHECK_COMPONENT_UNKNOWN")).toBe(false);
  });

  it("checks tool paths and declarations without executing them", async () => {
    const root = await project();
    await mkdir(join(root, "agent", "tools"));
    await writeFile(join(root, "agent", "tools", "bad_name.ts"), "throw new Error('must not execute');\n");
    const result = await validateAgent(root);
    expect(result.diagnostics.map((item) => item.code)).toContain("NYLO_CHECK_TOOL_NAME_INVALID");
  });
});

describe("build", () => {
  it("emits a deterministic bundle and manifest", async () => {
    const root = await project();
    const first = await buildAgent(root);
    expect(first.ok, first.diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n")).toBe(true);
    const manifest1 = await readFile(join(root, "dist", "nylo.manifest.json"), "utf8");
    const bundle1 = await readFile(join(root, "dist", "agent.mjs"));
    const second = await buildAgent(root);
    expect(second.ok).toBe(true);
    expect(await readFile(join(root, "dist", "nylo.manifest.json"), "utf8")).toBe(manifest1);
    expect(await readFile(join(root, "dist", "agent.mjs"))).toEqual(bundle1);
    expect((await readdir(join(root, "dist"))).sort()).toEqual(["agent.mjs", "nylo.manifest.json"]);
  });

  it("derives tools, skills, MCP, and secret names without leaking values", async () => {
    const root = await project();
    const sdk = JSON.stringify("@nylorun/agents");
    const zod = JSON.stringify(new URL("../node_modules/zod/index.js", import.meta.url).pathname);
    await mkdir(join(root, "agent", "tools"));
    await writeFile(join(root, "agent", "tools", "lookup.ts"), `import { z } from ${zod};\nimport { defineTool } from ${sdk};\nexport default defineTool({description:"Look up a record",input:z.object({id:z.string()}),run:({id})=>id});\n`);
    await mkdir(join(root, "agent", "skills", "review"), { recursive: true });
    await writeFile(join(root, "agent", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code carefully.\n---\n\n# Review\n");
    const secretValue = "never-emit-this-value";
    process.env.NYLO_TEST_SECRET = secretValue;
    await writeFile(join(root, "agent", "agent.ts"), `import { Agent } from ${sdk};\nexport default Agent({name:"sample",model:"anthropic/example",secrets:["NYLO_TEST_SECRET"],mcp:[{name:"docs",url:"https://example.test/mcp",secret:"NYLO_TEST_SECRET"}]});\n`);
    const result = await buildAgent(root);
    expect(result.ok).toBe(true);
    expect(result.manifest?.tools[0]).toMatchObject({ name: "lookup", inputSchema: { type: "object" } });
    expect(result.manifest?.skills[0]).toMatchObject({ name: "review" });
    expect(result.manifest?.mcp[0]).toMatchObject({ name: "docs", secret: "NYLO_TEST_SECRET" });
    const artifacts = `${await readFile(join(root, "dist", "agent.mjs"), "utf8")}\n${await readFile(join(root, "dist", "nylo.manifest.json"), "utf8")}\n${JSON.stringify(result.diagnostics)}`;
    expect(artifacts).not.toContain(secretValue);
    delete process.env.NYLO_TEST_SECRET;
  });

  it("returns stable diagnostics for missing and ambiguous instructions", async () => {
    const root = await project();
    await rm(join(root, "agent", "AGENT.md"));
    const absent = await buildAgent(root);
    expect(absent.diagnostics.map((item) => item.code), JSON.stringify(absent.diagnostics)).toContain("NYLO_BUILD_INSTRUCTIONS_ABSENT");
    await writeFile(join(root, "agent", "AGENT.md"), "File instructions.\n");
    const sdk = JSON.stringify("@nylorun/agents");
    await writeFile(join(root, "agent", "agent.ts"), `import { Agent } from ${sdk};\nexport default Agent({name:"sample",model:"anthropic/example",instructions:"Inline"});\n`);
    expect((await buildAgent(root)).diagnostics.map((item) => item.code)).toContain("NYLO_BUILD_INSTRUCTIONS_AMBIGUOUS");
  });

  it("diagnoses a missing plugin and overridden output", async () => {
    const root = await project();
    await writeFile(join(root, "vite.config.ts"), "export default {};\n");
    expect((await buildAgent(root)).diagnostics.map((item) => item.code)).toContain("NYLO_BUILD_PLUGIN_MISSING");
    const sdk = JSON.stringify("@nylorun/agents");
    await writeFile(join(root, "vite.config.ts"), `import { nyloAgent } from ${sdk};\nexport default {plugins:[nyloAgent(),{name:"override-nylo-output",configResolved(config){config.build.outDir="custom"}}]};\n`);
    const overridden = await buildAgent(root);
    expect(overridden.diagnostics.map((item) => item.code), JSON.stringify(overridden)).toContain("NYLO_BUILD_PLUGIN_OUTPUT_OVERRIDDEN");
  });
});
