import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../errors.js";

function cliPackageJsonPath(): string {
  // src/runtime/*.ts and dist/runtime/*.js both sit two levels below cli/.
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
}

/**
 * Recommended Runtime version from `cli/package.json` `nylorun.runtime` (D7):
 * the version named in install instructions. Compatibility itself is checked
 * by launcher and Host protocol, not by an exact match.
 */
export function runtimeVersion(): string {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(cliPackageJsonPath(), "utf8"));
  } catch (error) {
    throw new CliError(
      `Cannot read CLI package.json: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  const version = (raw as { nylorun?: { runtime?: unknown } })?.nylorun?.runtime;
  if (typeof version !== "string" || version.trim() === "") {
    throw new CliError(
      'cli/package.json is missing "nylorun.runtime" (the recommended Runtime version).',
      1,
    );
  }
  return version;
}
