import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const manifest = JSON.parse(readFileSync("package.json", "utf8"));
if (manifest.license !== "Apache-2.0")
  throw new Error("Studio must publish under Apache-2.0.");
if (
  manifest.repository?.url !== "git+https://github.com/nylorun/harness.git" ||
  manifest.repository?.directory !== "studio"
)
  throw new Error("Studio must reference its public source directory.");
if (manifest.bugs !== "https://github.com/nylorun/harness/issues")
  throw new Error("Studio must reference the public issue tracker.");
if (manifest.homepage !== "https://docs.nylorun.com")
  throw new Error("Studio homepage must point to Nylorun documentation.");
if (
  manifest.dependencies?.["@nylorun/create-agent"] !== undefined ||
  manifest.dependencies?.["@nylorun/create-harness"] !== undefined
)
  throw new Error("Studio must not depend on a project creator.");
if (manifest.bin) throw new Error("Studio must not own an executable.");
for (const field of [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
])
  for (const name of ["@nylorun/harness", "@nylorun/runtime"])
    if (manifest[field]?.[name])
      throw new Error(`Studio must not depend on ${name}`);
const cache = mkdtempSync(join(tmpdir(), "nylo-studio-pack-"));
const output = execFileSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["pack", "--json", "--dry-run", "--ignore-scripts"],
  { encoding: "utf8", env: { ...process.env, npm_config_cache: cache } },
);
rmSync(cache, { recursive: true, force: true });
const files = JSON.parse(output)[0].files.map((entry) => entry.path);
for (const required of [
  "package.json",
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "dist/host.js",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/web/index.html",
  "dist/web/nylo-studio.config.json",
  "dist/web/brand/nylorun-mark-white.svg",
  "dist/web/favicon/favicon.svg",
])
  if (!files.includes(required))
    throw new Error(`Missing tarball file: ${required}`);
if (files.includes("dist/ui.js"))
  throw new Error("Legacy inline Studio UI must not be packaged.");
console.log(`Studio tarball allowlist passed (${files.length} files).`);
