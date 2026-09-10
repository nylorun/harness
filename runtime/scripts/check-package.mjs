import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
for (const field of [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
])
  if (pkg[field]?.["@nylorun/harness"])
    throw new Error("Runtime must remain independent of Harness.");
function scan(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}/${item.name}`;
    if (item.isDirectory()) scan(path);
    else if (
      /\.(ts|js)$/.test(path) &&
      /["']@nylorun\/harness(?:[\/"'])/.test(readFileSync(path, "utf8"))
    )
      throw new Error(`Engine import in ${path}`);
  }
}
scan("src");
scan("dist");
const cache = mkdtempSync(join(tmpdir(), "nylorun-runtime-pack-"));
const output = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  { encoding: "utf8", env: { ...process.env, npm_config_cache: cache } },
);
rmSync(cache, { recursive: true, force: true });
const files = JSON.parse(output)[0].files.map((entry) => entry.path);
for (const path of [
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
])
  if (!files.includes(path)) throw new Error(`Missing ${path}`);
console.log("Runtime package and independence checks passed.");
