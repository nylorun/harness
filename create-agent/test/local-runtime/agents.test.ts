import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "../../src/local/runtime/index.js";
import { Agent, AgentSpec, Run, buildAgent, validateAgent } from "../../src/local/runtime/index.js";
import { Agent as HarnessAgent } from "@nylorun/harness";

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nylo-agents-"));
  await mkdir(join(root, "agent"), { recursive: true });
  await mkdir(join(root, "node_modules", "@nylorun"), { recursive: true });
  await symlink(new URL("../../", import.meta.url).pathname, join(root, "node_modules", "@nylorun", "create-agent"), "dir");
  await symlink(new URL("../../../harness/", import.meta.url).pathname, join(root, "node_modules", "@nylorun", "harness"), "dir");
  await symlink(new URL("../../../node_modules/zod/", import.meta.url).pathname, join(root, "node_modules", "zod"), "dir");
  await writeFile(join(root, "package.json"), '{"name":"@fixtures/sample","type":"module"}\n');
  await writeFile(join(root, "package-lock.json"), "{}\n");
  await writeFile(join(root, "vite.config.ts"), `import { nyloAgent } from "@nylorun/create-agent/local";\nexport default {plugins:[nyloAgent()]};\n`);
  await writeFile(join(root, "agent", "agent.ts"), `import { Run } from "@nylorun/create-agent/local";\nimport { Agent } from "@nylorun/harness";\nexport default Run((model,directive)=>Agent(model,directive),{model:"anthropic/example"});\n`);
  await writeFile(join(root, "agent", "AGENT.md"), "You are helpful.\n");
  return root;
}

describe("Agent", () => {
  // The barrel is the review artifact: every name here is a semver commitment, so this list is
  // meant to be edited deliberately rather than updated to make a build pass.
  it("keeps the runtime export barrel reviewed", () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      // Authoring and build
      "AUTHORING_REFERENCE", "Agent", "AgentSpec", "Run", "buildAgent", "createFilesystemReader", "tool",
      "isModelIdentity", "isPortableName", "nyloAgent", "validateAgent",
      "MODEL_GATEWAY_ACCESS_MODE_VARIABLE", "MODEL_GATEWAY_API_KEY_VARIABLE", "MODEL_GATEWAY_PROTOCOLS", "MODEL_GATEWAY_PROTOCOL_VARIABLE", "MODEL_GATEWAY_URL_VARIABLE", "OPENROUTER_VARIABLE",
      "OpenAICompatibleModelGatewayAdapter", "ModelGatewayError",
      "resolveCredential", "resolveModel",
      // Local execution: the door, the record store, and what the build calls to bind an agent
      "Fetchable", "__nyloBindAgent", "__nyloUnboundAgent",
      "NYLO_DIRECTORY", "createSessionJournal", "createMemorySessionStore", "redactRecord",
      // Publishing, client side
      "ARCHIVE_EXCLUSIONS", "checkPublish", "createAuthoringArchive", "watchAgent"
    ].sort());
  });
  it("normalizes optional collections", () => {
    expect(AgentSpec({ name: "sample", model: "anthropic/example" })).toMatchObject({ secrets: [], mcp: [] });
    expect(Agent({ name: "sample", model: "anthropic/example" })).toMatchObject({ secrets: [], mcp: [] });
  });

  it("requires a branded harness and keeps the two factories separate", () => {
    expect(Run((model, directive) => HarnessAgent(model, directive), { model: "anthropic/example" })).toMatchObject({
      harness: expect.any(Function), secrets: [], mcp: []
    });
    expect(() => Run({} as never, { model: "anthropic/example" })).toThrow("Harness factory");
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
    expect(first.manifest?.agent.name).toBe("sample");
    expect(first.manifest?.harness).toMatchObject({ name: "@nylorun/harness", version: "0.5.0-beta.1" });
    expect(JSON.parse(manifest1).harness).toMatchObject({ name: "@nylorun/harness", version: "0.5.0-beta.1" });
    expect(Object.keys(first.manifest ?? {}).sort()).toEqual(["agent", "bundleDigest", "digest", "formatVersion", "harness", "instructionsDigest", "mcp", "requirements", "sdkVersion", "skills", "tools"]);
  });

  it("refuses an omitted name when package.json cannot derive one", async () => {
    const root = await project();
    await writeFile(join(root, "package.json"), '{"type":"module"}\n');
    const result = await buildAgent(root);
    expect(result.diagnostics.map((item) => item.code)).toContain("NYLO_BUILD_NAME_UNDERIVABLE");
  });

  it("derives tools, skills, and secret names without leaking values", async () => {
    const root = await project();
    const sdk = JSON.stringify("@nylorun/create-agent/local");
    const zod = JSON.stringify("zod");
    await mkdir(join(root, "agent", "tools"));
    await writeFile(join(root, "agent", "tools", "lookup.ts"), `import { z } from ${zod};\nimport { tool } from ${sdk};\nexport default tool({description:"Look up a record",input:z.object({id:z.string()}),run:({id})=>id});\n`);
    await mkdir(join(root, "agent", "skills", "review"), { recursive: true });
    await writeFile(join(root, "agent", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code carefully.\n---\n\n# Review\n");
    const secretValue = "never-emit-this-value";
    process.env.NYLO_TEST_SECRET = secretValue;
    await writeFile(join(root, "agent", "agent.ts"), `import { AgentSpec } from ${sdk};\nexport default AgentSpec({name:"sample",model:"anthropic/example",secrets:["NYLO_TEST_SECRET"]});\n`);
    const result = await buildAgent(root);
    expect(result.ok).toBe(true);
    expect(result.manifest?.tools[0]).toMatchObject({ name: "lookup", inputSchema: { type: "object" } });
    expect(result.manifest?.skills[0]).toMatchObject({ name: "review" });
    expect(result.manifest?.mcp).toEqual([]);
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
    const sdk = JSON.stringify("@nylorun/create-agent/local");
    await writeFile(join(root, "agent", "agent.ts"), `import { AgentSpec } from ${sdk};\nexport default AgentSpec({name:"sample",model:"anthropic/example",instructions:"Inline"});\n`);
    expect((await buildAgent(root)).diagnostics.map((item) => item.code)).toContain("NYLO_BUILD_INSTRUCTIONS_AMBIGUOUS");
  });

  it("diagnoses a missing plugin and overridden output", async () => {
    const root = await project();
    await writeFile(join(root, "vite.config.ts"), "export default {};\n");
    expect((await buildAgent(root)).diagnostics.map((item) => item.code)).toContain("NYLO_BUILD_PLUGIN_MISSING");
    const sdk = JSON.stringify("@nylorun/create-agent/local");
    await writeFile(join(root, "vite.config.ts"), `import { nyloAgent } from ${sdk};\nexport default {plugins:[nyloAgent(),{name:"override-nylo-output",configResolved(config){config.build.outDir="custom"}}]};\n`);
    const overridden = await buildAgent(root);
    expect(overridden.diagnostics.map((item) => item.code), JSON.stringify(overridden)).toContain("NYLO_BUILD_PLUGIN_OUTPUT_OVERRIDDEN");
  });
});
