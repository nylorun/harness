import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (!pkg.dependencies?.["@nylorun/harness"])
  throw new Error("Runtime must use canonical Harness contracts through a direct dependency.");
if (pkg.bin?.["nylorun-runtime"] !== "dist/launcher/main.js")
  throw new Error('Runtime must expose the launcher as bin "nylorun-runtime" (dist/launcher/main.js).');
if (!readFileSync("dist/launcher/main.js", "utf8").startsWith("#!/usr/bin/env node\n"))
  throw new Error("dist/launcher/main.js must start with a node shebang.");
const cache = mkdtempSync(join(tmpdir(), "nylorun-runtime-pack-"));
const output = execFileSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8", env: { ...process.env, npm_config_cache: cache } },
);
rmSync(cache, { recursive: true, force: true });
const files = JSON.parse(output)[0].files.map((entry) => entry.path);
const version = readFileSync("dist/version.js", "utf8");
const declared = /RUNTIME_VERSION = "([^"]+)"/.exec(version)?.[1];
if (declared !== pkg.version)
  throw new Error(
    `RUNTIME_VERSION is ${declared} but package.json is ${pkg.version}; update runtime/src/version.ts.`,
  );
for (const path of [
  "dist/configuration.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/node/index.js",
  "dist/core/runtime.js",
  "dist/host/main.js",
  "dist/launcher/main.js",
  "dist/version.js",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
])
  if (!files.includes(path)) throw new Error(`Missing ${path}`);
console.log("Runtime Node host package checks passed.");
