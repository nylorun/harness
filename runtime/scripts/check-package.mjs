import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (!pkg.dependencies?.["@nylorun/harness"])
  throw new Error("Runtime must use canonical Harness contracts through a direct dependency.");
const cache = mkdtempSync(join(tmpdir(), "nylorun-runtime-pack-"));
const output = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8", env: { ...process.env, npm_config_cache: cache } },
);
rmSync(cache, { recursive: true, force: true });
const files = JSON.parse(output)[0].files.map((entry) => entry.path);
for (const path of [
  "dist/configuration.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/node/index.js",
  "dist/node/local-sessions.js",
  "dist/core/runtime.js",
  "dist/core/main.js",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
])
  if (!files.includes(path)) throw new Error(`Missing ${path}`);
console.log("Runtime Node host package checks passed.");
