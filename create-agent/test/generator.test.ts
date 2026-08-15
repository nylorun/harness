import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateAgentProject } from "../src/generator.js";

describe("generateAgentProject", () => {
  it("writes the minimal build-only project", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "create-nylo-"));
    const result = await generateAgentProject({ directory: "reviewer", model: "anthropic/example", cwd, install: false, userAgent: "npm/11.0.0", agentsSpec: "file:../agents.tgz" });
    expect(result.packageManager).toBe("npm");
    const manifest = JSON.parse(await readFile(join(cwd, "reviewer", "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual({ "@nylorun/agents": "file:../agents.tgz" });
    expect(manifest.scripts).toHaveProperty("build");
    expect(manifest.scripts).not.toHaveProperty("dev");
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
    expect(manifest.dependencies).toEqual({ "@nylorun/agents": "^0.1.0-rc.0" });
    await expect(readFile(join(cwd, "reviewer", "agent", "tools", "example.ts"))).rejects.toThrow();
    await expect(readFile(join(cwd, "reviewer", "agent", "memory", "README.md"))).rejects.toThrow();
  });
});
