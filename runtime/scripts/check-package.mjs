import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cache = mkdtempSync(join(tmpdir(), "nylo-pack-cache-"));
try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const output = execFileSync(npm, ["pack", "--json", "--dry-run", "--ignore-scripts"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: cache }
  });
  const files = JSON.parse(output)[0].files.map((entry) => entry.path);
  const unexpected = files.filter((path) =>
    path !== "package.json" &&
    path !== "README.md" &&
    path !== "LICENSE" &&
    !/^dist\/.+\.(?:js|d\.ts)$/.test(path)
  );
  if (unexpected.length) throw new Error(`Unexpected tarball files: ${unexpected.join(", ")}`);
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    "dist/index.js",
    "dist/index.d.ts"
  ]) {
    if (!files.includes(required)) throw new Error(`Missing tarball file: ${required}`);
  }
  console.log(`Tarball allowlist passed (${files.length} files).`);
} finally {
  rmSync(cache, { recursive: true, force: true });
}
