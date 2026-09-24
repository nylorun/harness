/**
 * // CLIENTS-CCR: owned by WS-F1 — reads `cli/package.json` `nylorun.runtime`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../errors.js";

function cliPackageJsonPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "package.json",
  );
}

/** Pinned Runtime build version from `cli/package.json` `nylorun.runtime` (D7). */
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
  const version = (raw as { nylorun?: { runtime?: unknown } })?.nylorun
    ?.runtime;
  if (typeof version === "string" && version.trim() !== "") return version;
  // CLIENTS-CCR: F1 adds nylorun.runtime; transitional fallback for local tests.
  return "0.9.0-beta";
}
