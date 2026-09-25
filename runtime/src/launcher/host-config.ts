import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { newTenantId } from "@nylorun/core/compatibility";
import { LauncherError } from "./errors.js";
import type { HostPaths } from "./paths.js";
import type { HostConfigFileV1 } from "./protocol.js";

const KNOWN_FORMAT = 1;

export type HostConfigFile = HostConfigFileV1 & Record<string, unknown>;

export const HOST_ID_PATTERN = /^host_[0-9a-hjkmnp-tv-z]{26}$/;

export function newHostId(): string {
  return `host_${newTenantId().slice(3)}`;
}

export function isHostId(value: unknown): value is string {
  return typeof value === "string" && HOST_ID_PATTERN.test(value);
}

function formatOf(value: Record<string, unknown>): number {
  if (value.format === undefined) return 0;
  if (typeof value.format === "number" && Number.isInteger(value.format)) {
    return value.format;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Read host.json. Missing `format` means Tenants-era format 0.
 * Returns undefined when absent or structurally invalid.
 */
export async function readHostConfig(
  paths: HostPaths,
): Promise<HostConfigFile | undefined> {
  try {
    const value = JSON.parse(await readFile(paths.config, "utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof value.hostId !== "string" ||
      typeof value.host !== "string" ||
      typeof value.port !== "number"
    ) {
      return undefined;
    }
    return value as HostConfigFile;
  } catch {
    return undefined;
  }
}

/**
 * Write host.json at format 1. Upgrades format 0, keeps unknown fields, and
 * refuses files with a newer format (`host_format_newer`).
 */
export async function writeHostConfig(
  paths: HostPaths,
  config: HostConfigFile,
): Promise<void> {
  const existing = await readHostConfig(paths);
  if (existing) {
    const existingFormat = formatOf(existing);
    if (existingFormat > KNOWN_FORMAT) {
      throw new LauncherError(
        "host_format_newer",
        `host.json format ${existingFormat} is newer than this launcher supports (${KNOWN_FORMAT}).`,
        "Upgrade the Runtime (npm install --global @nylorun/runtime@latest), then retry.",
        { format: existingFormat, known: KNOWN_FORMAT },
      );
    }
  }

  const merged: HostConfigFile = {
    ...(existing ?? {}),
    ...config,
    format: 1,
  };

  const temporary = `${paths.config}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(merged, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, paths.config);
}

export function hostConfigFormat(config: HostConfigFile): number {
  return formatOf(config);
}
