/**
 * Merge per-platform builds-*.json shards from the publish matrix into
 * builds.json for publish.mjs / readRuntimeBuildArtifacts.
 */
import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runtimeBuildPublishOrder } from "./runtime-build-validate.mjs";
import { readJson, root } from "../lib/repo.mjs";

const download = join(root, ".tmp/release-artifacts/runtime-builds-download");
const out = join(root, ".tmp/release-artifacts/runtime-builds");
await mkdir(out, { recursive: true });

async function collect(dir, files = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path, files);
    else files.push(path);
  }
  return files;
}

const found = await collect(download);
for (const path of found) {
  if (path.endsWith(".tgz") || /builds-.+\.json$/.test(path)) {
    await copyFile(path, join(out, path.split(/[/\\]/).at(-1)));
  }
}

const shards = (await readdir(out)).filter(
  (name) => name.startsWith("builds-") && name.endsWith(".json"),
);
const merged = { runtimeVersion: undefined, builds: {} };
for (const file of shards) {
  const part = await readJson(join(out, file));
  merged.runtimeVersion ??= part.runtimeVersion;
  if (part.runtimeVersion !== merged.runtimeVersion)
    throw new Error(`Conflicting runtimeVersion in ${file}`);
  Object.assign(merged.builds, part.builds);
}

const expected = runtimeBuildPublishOrder();
const missing = expected.filter((name) => !merged.builds[name]);
if (missing.length)
  throw new Error(
    `Expected 5 Runtime build packages; missing ${missing.join(", ")}. Have: ${Object.keys(merged.builds).join(", ") || "(none)"}`,
  );

await writeFile(join(out, "builds.json"), JSON.stringify(merged, null, 2) + "\n");
console.log(
  `Merged Runtime builds for ${merged.runtimeVersion}: ${expected.join(", ")}`,
);
