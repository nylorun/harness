import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { checkBoundaries } from "../../scripts/check-boundaries.mjs";
checkBoundaries("cli");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.bin?.nylorun !== "dist/cli.js")
  throw new Error("Missing nylorun binary");
for (const path of [
  "dist/cli.js",
  "dist/project-runner.js",
  "dist/model/configure.js",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
])
  if (!existsSync(path)) throw new Error(`Missing CLI artifact: ${path}`);
createRequire(import.meta.url).resolve("@nylorun/runtime/server");
