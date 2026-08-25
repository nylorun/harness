import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAgentProject } from "../src/generator.js";

describe("generateAgentProject", () => {
  it("writes the minimal project with the REST server as its only execution bootstrap", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    const result = await generateAgentProject({ directory: "reviewer", model: "anthropic/example", cwd, install: false, userAgent: "npm/11.0.0", agentsSpec: "file:../agents.tgz" });
    expect(result.packageManager).toBe("npm");
    const manifest = JSON.parse(await readFile(join(cwd, "reviewer", "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@nylorun/runtime": "file:../agents.tgz", "@nylorun/harness": "^0.4.0-rc.1", "zod": "^4.1.12" });
    expect(manifest.devDependencies["@nylorun/studio"]).toBe("^0.1.0-rc.1");
    expect(manifest.scripts).toHaveProperty("build");
    expect(manifest.scripts.dev).toBe("nylo dev --studio");
    expect(manifest.scripts.serve).toBe("npm run build && nylo serve");
    expect(manifest.scripts.studio).toBe("nylo studio");
  });

  it("supports the same runtimes the generator itself does", async () => {
    // These drifted apart once already: the generator's own engines were widened to the supported
    // LTS lines while the template it writes kept a single line that had entered maintenance, so a
    // generated project warned on install under the runtime most builders use. Tying them together
    // is what stops that being a thing anyone has to remember.
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    await generateAgentProject({ directory: "reviewer", model: "anthropic/example", cwd, install: false });
    const generated = JSON.parse(await readFile(join(cwd, "reviewer", "package.json"), "utf8"));
    const own = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(generated.engines.node).toBe(own.engines.node);
  });

  it("pins the transitive harness only when a development spec is supplied", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    await generateAgentProject({ directory: "plain", model: "anthropic/example", cwd, install: false });
    expect(JSON.parse(await readFile(join(cwd, "plain", "package.json"), "utf8"))).not.toHaveProperty("overrides");

    await generateAgentProject({
      directory: "pinned",
      model: "anthropic/example",
      cwd,
      install: false,
      harnessSpec: "file:../harness.tgz"
    });
    const pinned = JSON.parse(await readFile(join(cwd, "pinned", "package.json"), "utf8"));
    expect(pinned.overrides).toEqual({ "@nylorun/harness": "file:../harness.tgz" });
  });

  it("refuses invalid model identities", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    await expect(generateAgentProject({ directory: "reviewer", model: "invalid", cwd, install: false })).rejects.toThrow("Invalid model identity");
  });

  it("refuses a non-empty target without overwriting it", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    await mkdir(join(cwd, "reviewer"));
    await writeFile(join(cwd, "reviewer", "keep.txt"), "mine\n");
    await expect(generateAgentProject({ directory: "reviewer", model: "anthropic/example", cwd, install: false })).rejects.toThrow("not empty");
    expect(await readFile(join(cwd, "reviewer", "keep.txt"), "utf8")).toBe("mine\n");
  });

  it("prefers a declared project package manager over the invoking runner", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    await writeFile(join(cwd, "package.json"), '{"packageManager":"pnpm@10.0.0"}\n');
    const result = await generateAgentProject({ directory: "reviewer", model: "anthropic/example", cwd, install: false, userAgent: "npm/11.0.0" });
    expect(result).toMatchObject({ packageManager: "pnpm", reason: "package.json declares pnpm@10.0.0" });
  });

  it("generates only the documented minimal files", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    await generateAgentProject({ directory: "reviewer", model: "anthropic/example", cwd, install: false });
    const manifest = JSON.parse(await readFile(join(cwd, "reviewer", "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@nylorun/runtime": "^0.1.0-rc.1", "@nylorun/harness": "^0.4.0-rc.1", "zod": "^4.1.12" });
    await expect(readFile(join(cwd, "reviewer", "agent", "tools", "example.ts"))).rejects.toThrow();
    await expect(readFile(join(cwd, "reviewer", "agent", "memory", "README.md"))).rejects.toThrow();
  });

  it("writes a vendor-neutral gateway template", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    await generateAgentProject({ directory: "reviewer", model: "anthropic/example", cwd, install: false });
    const template = await readFile(join(cwd, "reviewer", ".env.example"), "utf8");
    expect(template).toContain("NYLO_MODEL_GATEWAY_URL=");
    expect(template).not.toContain("OPENROUTER_API_KEY=");
    expect(await readFile(join(cwd, "reviewer", ".gitignore"), "utf8")).toContain(".env");
  });

  it("writes an explicit deferred Harness factory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    await generateAgentProject({ directory: "reviewer", model: "local/gemma4:e2b-mlx", cwd, install: false });
    const definition = await readFile(join(cwd, "reviewer", "agent", "agent.ts"), "utf8");
    expect(definition).toContain('import { Agent } from "@nylorun/harness"');
    expect(definition).toContain("(model) => Agent(model)");
    const template = await readFile(join(cwd, "reviewer", ".env.example"), "utf8");
    expect(template).toContain("http://127.0.0.1:11434/v1");
    expect(template).not.toContain("API_KEY");
  });

  it("uses the selected package manager in the serve script", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    await writeFile(join(cwd, "package.json"), '{"packageManager":"pnpm@10.0.0"}\n');
    await generateAgentProject({ directory: "reviewer", model: "anthropic/example", cwd, install: false });
    const manifest = JSON.parse(await readFile(join(cwd, "reviewer", "package.json"), "utf8"));
    expect(manifest.scripts.serve).toBe("pnpm run build && nylo serve");
  });
});
