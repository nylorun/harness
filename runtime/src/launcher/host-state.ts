import { randomBytes } from "node:crypto";
import { unlink } from "node:fs/promises";
import { readFile, rename, writeFile, chmod } from "node:fs/promises";
import type { HostPaths } from "./paths.js";

export interface HostStateFile {
  pid: number;
  startedAt: string;
  version: string;
  entry: string;
  url: string;
}

export interface HostCredentialsFile {
  adminKey: string;
}

export async function readHostState(
  paths: HostPaths,
): Promise<HostStateFile | undefined> {
  try {
    const value = JSON.parse(
      await readFile(paths.state, "utf8"),
    ) as HostStateFile;
    return typeof value?.pid === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeHostState(
  paths: HostPaths,
  state: HostStateFile,
): Promise<void> {
  const temporary = `${paths.state}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, paths.state);
}

export async function clearHostState(paths: HostPaths): Promise<void> {
  try {
    await unlink(paths.state);
  } catch {
    /* absent */
  }
}

export async function readHostCredentials(
  paths: HostPaths,
): Promise<HostCredentialsFile | undefined> {
  try {
    const value = JSON.parse(
      await readFile(paths.credentials, "utf8"),
    ) as HostCredentialsFile;
    if (
      typeof value?.adminKey === "string" &&
      /^[0-9a-f]{64}$/.test(value.adminKey)
    ) {
      return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Create host-credentials.json mode 0600 if missing (Tenants D15). */
export async function ensureHostCredentials(
  paths: HostPaths,
): Promise<HostCredentialsFile> {
  const existing = await readHostCredentials(paths);
  if (existing) return existing;
  const credentials: HostCredentialsFile = {
    adminKey: randomBytes(32).toString("hex"),
  };
  const temporary = `${paths.credentials}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(credentials)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, paths.credentials);
  try {
    await chmod(paths.credentials, 0o600);
  } catch {
    /* best-effort */
  }
  return credentials;
}
