import { readFileSync, existsSync } from "node:fs";
import { checkBoundaries } from "../../scripts/check-boundaries.mjs";
checkBoundaries("cli");
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.bin?.nylorun !== "dist/cli.js")
  throw new Error("Missing nylorun binary");
const deps = Object.keys(pkg.dependencies ?? {}).sort();
const expected = [
  "@earendil-works/pi-ai",
  "@nylorun/admin",
  "@nylorun/agents",
].sort();
if (JSON.stringify(deps) !== JSON.stringify(expected)) {
  throw new Error(
    `CLI dependencies must be exactly ${expected.join(", ")}; got ${deps.join(", ")}`,
  );
}
for (const path of [
  "dist/cli.js",
  "dist/model/configure.js",
  "dist/dev.js",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
])
  if (!existsSync(path)) throw new Error(`Missing CLI artifact: ${path}`);
