/**
 * Runtime version pin (D7, G3): cli/package.json nylorun.runtime must equal
 * the @nylorun/runtime version. The CLI names it in install instructions.
 */
import { join } from "node:path";
import { readJson, root, writeJson } from "../lib/repo.mjs";

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

/** Fail when the D7 pin is missing or disagrees with the runtime version. */
export async function assertRuntimePins(repo = root) {
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
