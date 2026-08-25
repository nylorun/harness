import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const forbidden = ["@nylorun/runtime", "@nylorun/agent"];
const production = { ...(manifest.dependencies ?? {}), ...(manifest.optionalDependencies ?? {}) };
for (const name of forbidden) {
  if (name in production) throw new Error(`Forbidden production dependency: ${name}`);
}
const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
for (const file of sourceFiles("src").filter((path) => path.endsWith(".ts"))) {
  const source = readFileSync(file, "utf8");
  for (const name of forbidden) {
    if (source.includes(name))
      throw new Error(`Forbidden source import reference ${name} in ${file}`);
  }
}

const cache = mkdtempSync(join(tmpdir(), "nylo-harness-pack-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npm, ["pack", "--json", "--dry-run", "--ignore-scripts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cache },
  });
  const files = JSON.parse(output)[0].files.map((entry) => entry.path);
  const allowed = (path) =>
    path === "package.json" ||
    path === "README.md" ||
    path === "LICENSE" ||
    /^dist\/.+\.(?:js|d\.ts)$/.test(path);
  const unexpected = files.filter((path) => !allowed(path));
  if (unexpected.length) throw new Error(`Unexpected tarball files: ${unexpected.join(", ")}`);
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    if (!files.includes(required)) throw new Error(`Missing tarball file: ${required}`);
  }
  const entry = await import(new URL("../dist/index.js", import.meta.url));
  for (const name of [
    "Harness",
    "AgentBuildError",
    "Agent",
    "defineCapability",
    "defineTool",
    "defineMiddleware",
    "defineAdapter",
    "defineModel",
  ]) {
    if (!(name in entry)) throw new Error(`Missing public export: ${name}`);
  }
  console.log(`Tarball and dependency boundary passed (${files.length} files).`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}
