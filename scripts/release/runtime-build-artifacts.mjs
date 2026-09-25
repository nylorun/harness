/**
 * Load packed Runtime build tarballs produced by the publish.yml matrix
 * (D8 / D17). Expects `.tmp/release-artifacts/runtime-builds/<platform>-<arch>/*.tgz`
 * plus a `builds.json` index written by the build job.
 */
import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { integrity } from "./artifacts.mjs";
import { runtimeBuildPublishOrder } from "./runtime-build-validate.mjs";
import { readJson } from "../lib/repo.mjs";

export async function readRuntimeBuildArtifacts(directory, runtimeVersion) {
  const indexPath = join(directory, "builds.json");
  let index;
  try {
    index = await readJson(indexPath);
  } catch (error) {
    if (error.code === "ENOENT")
      throw new Error(
        `Missing Runtime build index at ${indexPath}. The publish matrix must upload four platform tarballs.`,
      );
    throw error;
  }
  if (index.runtimeVersion !== runtimeVersion)
    throw new Error(
      `Runtime build index version ${index.runtimeVersion} does not match plan runtime ${runtimeVersion}.`,
    );
  const artifacts = {};
  for (const name of runtimeBuildPublishOrder()) {
    const entry = index.builds?.[name];
    if (!entry?.file)
      throw new Error(`Runtime build index missing ${name}.`);
    if (entry.version !== runtimeVersion)
      throw new Error(
        `Build ${name} version ${entry.version} must equal runtime ${runtimeVersion}.`,
      );
    const path = join(directory, entry.file);
    const hash = await integrity(path);
    if (entry.integrity && entry.integrity !== hash)
      throw new Error(`Runtime build artifact was modified: ${name}.`);
    artifacts[name] = {
      name,
      version: runtimeVersion,
      file: basename(entry.file),
      path,
      integrity: hash,
    };
  }
  return artifacts;
}

/**
 * Write builds.json after packing one platform in CI.
 */
export async function writeBuildIndexEntry({
  directory,
  runtimeVersion,
  name,
  version,
  tarballPath,
}) {
  const existing = await readJson(join(directory, "builds.json")).catch(() => ({
    runtimeVersion,
    builds: {},
  }));
  if (existing.runtimeVersion && existing.runtimeVersion !== runtimeVersion)
    throw new Error("Conflicting runtimeVersion in builds.json.");
  const hash = await integrity(tarballPath);
  existing.runtimeVersion = runtimeVersion;
  existing.builds ??= {};
  existing.builds[name] = {
    version,
    file: basename(tarballPath),
    integrity: hash,
  };
  return existing;
}

export async function listTarballs(directory) {
  const entries = await readdir(directory).catch(() => []);
  return entries.filter((name) => name.endsWith(".tgz"));
}
