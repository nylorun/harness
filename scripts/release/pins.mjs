/**
 * Runtime build version pins (D6, D7, G3).
 *
 * - runtime/package.json nylorun.node must equal .node-version
 * - cli/package.json nylorun.runtime must equal the @nylorun/runtime version
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson, root, writeJson } from "../lib/repo.mjs";

export async function readPinnedNodeVersion(repo = root) {
  return (await readFile(join(repo, ".node-version"), "utf8")).trim();
}

export async function assertNodePin(repo = root) {
  const expected = await readPinnedNodeVersion(repo);
  const pkg = await readJson(join(repo, "runtime/package.json"));
  const actual = pkg.nylorun?.node;
  if (actual !== expected) {
    throw new Error(
      `runtime/package.json nylorun.node (${actual ?? "missing"}) must equal .node-version (${expected}).`,
    );
  }
  return expected;
}

export async function assertCliRuntimePin(repo = root) {
  const runtimeVersion = (await readJson(join(repo, "runtime/package.json")))
    .version;
  const cli = await readJson(join(repo, "cli/package.json"));
  const actual = cli.nylorun?.runtime;
  if (actual !== runtimeVersion) {
    throw new Error(
      `cli/package.json nylorun.runtime (${actual ?? "missing"}) must equal runtime version (${runtimeVersion}).`,
    );
  }
  return runtimeVersion;
}

/** Fail when D6/D7 pins are missing or disagree with the sources of truth. */
export async function assertRuntimePins(repo = root) {
  await assertNodePin(repo);
  await assertCliRuntimePin(repo);
}

/**
 * Keep cli/package.json nylorun.runtime equal to the released runtime version
 * (D7). Called from release:prepare.
 */
export async function syncCliRuntimePin(repo, runtimeVersion) {
  if (!runtimeVersion)
    throw new Error("syncCliRuntimePin requires a runtime version.");
  const path = join(repo, "cli/package.json");
  const manifest = await readJson(path);
  manifest.nylorun = { ...manifest.nylorun, runtime: runtimeVersion };
  await writeJson(path, manifest);
  return runtimeVersion;
}
