import { mkdtemp, mkdir, readFile, rm, writeFile, realpath } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ensureDataDir, findProjectRoot, resolveScope } from "../src/scope.js";

const roots: string[] = [];
async function temporary(prefix = "nylorun-scope-") {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}
beforeEach(() => {
  vi.stubEnv("NYLORUN_HOME", "");
  vi.stubEnv("NYLORUN_PORT", "");
  vi.stubEnv("PORT", "");
  vi.stubEnv("NYLORUN_SQLITE_PATH", "");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it("prefers the nearest .nylorun over a closer package.json", async () => {
  const root = await temporary();
  await mkdir(join(root, ".nylorun"), { recursive: true });
  const nested = join(root, "packages/app/src");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "packages/app/package.json"), "{}");
  expect(findProjectRoot(nested)).toBe(root);
});

it("falls back to the nearest package.json", async () => {
  const root = await temporary();
  const nested = join(root, "packages/app/src");
  await mkdir(nested, { recursive: true });
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, "packages/app/package.json"), "{}");
  expect(findProjectRoot(nested)).toBe(join(root, "packages/app"));
});

it("never treats the home directory as a project", async () => {
  const home = await temporary("nylorun-home-");
  await writeFile(join(home, "package.json"), "{}");
  await mkdir(join(home, ".nylorun"), { recursive: true });
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  expect(findProjectRoot(home)).toBeUndefined();
  expect(resolveScope({ cwd: home }).kind).toBe("global");
});

it("relocates only the global scope with NYLORUN_HOME", async () => {
  const project = await temporary();
  await writeFile(join(project, "package.json"), "{}");
  const home = await temporary("nylorun-home-");
  vi.stubEnv("NYLORUN_HOME", home);
  const scoped = resolveScope({ cwd: project });
  expect(scoped.kind).toBe("project");
  expect(scoped.dataDir).toBe(join(project, ".nylorun"));
  const global = resolveScope({ cwd: project, global: true });
  expect(global.kind).toBe("global");
  expect(global.dataDir).toBe(home);
});

it("resolves the port by flag, then environment, then recorded state", async () => {
  const project = await temporary();
  await writeFile(join(project, "package.json"), "{}");
  expect(resolveScope({ cwd: project }).port).toBe(8787);

  await mkdir(join(project, ".nylorun"), { recursive: true });
  await writeFile(
    join(project, ".nylorun/runtime.json"),
    JSON.stringify({ pid: 1, port: 5000 })
  );
  expect(resolveScope({ cwd: project }).port).toBe(5000);

  vi.stubEnv("PORT", "6000");
  expect(resolveScope({ cwd: project }).port).toBe(6000);
  vi.stubEnv("NYLORUN_PORT", "7000");
  expect(resolveScope({ cwd: project }).port).toBe(7000);
  expect(resolveScope({ cwd: project, port: 9000 }).port).toBe(9000);
});

it("rejects a port outside the valid range", async () => {
  const project = await temporary();
  await writeFile(join(project, "package.json"), "{}");
  vi.stubEnv("PORT", "0");
  expect(() => resolveScope({ cwd: project })).toThrow("between 1 and 65535");
});

it("creates a private data directory and ignores it only when a .gitignore exists", async () => {
  const project = await temporary();
  await writeFile(join(project, "package.json"), "{}");
  const scope = resolveScope({ cwd: project });
  await ensureDataDir(scope);
  expect(statSync(scope.dataDir).mode & 0o777).toBe(0o700);
  // Creating a .gitignore for a project that chose not to have one would be a surprise.
  await expect(readFile(join(project, ".gitignore"))).rejects.toThrow();

  await writeFile(join(project, ".gitignore"), "node_modules");
  await ensureDataDir(scope);
  await ensureDataDir(scope);
  const ignore = await readFile(join(project, ".gitignore"), "utf8");
  expect(ignore).toBe("node_modules\n.nylorun/\n");
});

it("leaves an existing project database in place", async () => {
  const project = await temporary();
  await writeFile(join(project, "package.json"), "{}");
  await mkdir(join(project, ".nylorun"), { recursive: true });
  await writeFile(join(project, ".nylorun/runtime.sqlite"), "existing");
  const scope = resolveScope({ cwd: project });
  await ensureDataDir(scope);
  expect(await readFile(scope.sqlitePath, "utf8")).toBe("existing");
});
