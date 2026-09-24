import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { newTenantId } from "@nylorun/agents";
import { CliError } from "../errors.js";

/** host.json — durable, no secrets (Wave 0 frozen shape). */
export interface HostConfigFile {
  hostId: string;
  host: string;
  port: number;
  allowNonLoopback?: boolean;
  proxy?: {
    httpsProxy?: string;
    noProxy?: string;
    nodeExtraCaCerts?: string;
  };
}

/** host-state.json — process only (Wave 0 frozen shape). */
export interface HostStateFile {
  pid: number;
  startedAt: string;
  version: string;
  entry: string;
  url: string;
}

/** host-credentials.json, mode 0600 (Wave 0 frozen shape). */
export interface HostCredentialsFile {
  adminKey: string;
}

/** Layout under the Host root (matches runtime `hostPaths`). */
export interface HostPaths {
  root: string;
  config: string;
  state: string;
  credentials: string;
  log: string;
  home: string;
  tmp: string;
  runtime: string;
  tenants: string;
  trash: string;
}

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
export const HOST_ID_PATTERN = /^host_[0-9a-hjkmnp-tv-z]{26}$/;

const setting = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
};

/** `host_` + 26 Crockford chars (same alphabet as Tenant ids). */
export function newHostId(): string {
  return `host_${newTenantId().slice(3)}`;
}

export function isHostId(value: unknown): value is string {
  return typeof value === "string" && HOST_ID_PATTERN.test(value);
}

/**
 * Host root: `NYLORUN_HOME` or `~/.nylorun`, resolved absolute once.
 */
export function resolveHostRoot(env: {
  NYLORUN_HOME?: string;
  HOME?: string;
} = process.env): string {
  const home = env.NYLORUN_HOME;
  if (home !== undefined && home.trim() !== "") return resolve(home);
  return resolve(join(env.HOME ?? homedir(), ".nylorun"));
}

export function hostPaths(hostRoot: string): HostPaths {
  const root = resolve(hostRoot);
  return {
    root,
    config: join(root, "host.json"),
    state: join(root, "host-state.json"),
    credentials: join(root, "host-credentials.json"),
    log: join(root, "runtime.log"),
    home: join(root, "home"),
    tmp: join(root, "tmp"),
    runtime: join(root, "runtime"),
    tenants: join(root, "tenants"),
    trash: join(root, "trash"),
  };
}

export async function ensureHostLayout(paths: HostPaths): Promise<void> {
  for (const dir of [
    paths.root,
    paths.home,
    paths.tmp,
    paths.runtime,
    paths.tenants,
    paths.trash,
  ]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
}

export function readHostConfigSync(paths: HostPaths): HostConfigFile | undefined {
  try {
    const value = JSON.parse(readFileSync(paths.config, "utf8")) as HostConfigFile;
    if (
      typeof value?.hostId !== "string" ||
      typeof value.host !== "string" ||
      typeof value.port !== "number"
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export async function readHostConfig(
  paths: HostPaths,
): Promise<HostConfigFile | undefined> {
  try {
    const value = JSON.parse(await readFile(paths.config, "utf8")) as HostConfigFile;
    if (
      typeof value?.hostId !== "string" ||
      typeof value.host !== "string" ||
      typeof value.port !== "number"
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export async function writeHostConfig(
  paths: HostPaths,
  config: HostConfigFile,
): Promise<void> {
  const temporary = `${paths.config}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, paths.config);
}

export async function readHostState(
  paths: HostPaths,
): Promise<HostStateFile | undefined> {
  try {
    const value = JSON.parse(await readFile(paths.state, "utf8")) as HostStateFile;
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

/**
 * Create `host-credentials.json` mode 0600 if missing (D15).
 * Returns the admin key (never log it).
 */
export async function ensureHostCredentials(
  paths: HostPaths,
): Promise<HostCredentialsFile> {
  try {
    const existing = JSON.parse(
      await readFile(paths.credentials, "utf8"),
    ) as HostCredentialsFile;
    if (
      typeof existing?.adminKey === "string" &&
      /^[0-9a-f]{64}$/.test(existing.adminKey)
    ) {
      return existing;
    }
  } catch {
    /* create */
  }
  const credentials: HostCredentialsFile = {
    adminKey: randomBytes(32).toString("hex"),
  };
  const temporary = `${paths.credentials}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  await rename(temporary, paths.credentials);
  try {
    await chmod(paths.credentials, 0o600);
  } catch {
    /* best-effort on platforms without chmod */
  }
  return credentials;
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

export function hostUrl(config: Pick<HostConfigFile, "host" | "port">): string {
  return `http://${config.host}:${config.port}`;
}

/** True when the address accepts a new listen (nothing bound). */
export async function portBindable(
  host: string,
  port: number,
): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolvePromise) => {
    server.once("error", () => resolvePromise(false));
    server.listen(port, host, () => server.close(() => resolvePromise(true)));
  });
}

async function findFreeLoopbackPort(host: string): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a free loopback port."));
        return;
      }
      const { port } = address;
      server.close(() => resolvePromise(port));
    });
  });
}

export interface ProbeHealthResult {
  reachable: boolean;
  health?: {
    status: string;
    service: string;
    version?: string;
    hostId?: string;
    pid?: number;
    protocol?: { min: number; max: number; features: string[] };
    coreVersion?: string;
  };
  /** Something answered but is not a Nylorun Runtime Host. */
  foreign?: boolean;
}

export async function probeHostHealth(
  url: string,
  timeoutMs = 2000,
): Promise<ProbeHealthResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${url}/health`, { signal });
  } catch {
    return { reachable: false };
  }
  if (!response.ok) return { reachable: true, foreign: true };
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (body?.status !== "ok" || typeof body.service !== "string") {
      return { reachable: true, foreign: true };
    }
    // Accept legacy "oss-runtime" and the Host service name.
    if (body.service !== "oss-runtime" && body.service !== "nylorun-runtime") {
      return { reachable: true, foreign: true };
    }
    const protocol = body.protocol as
      | { min?: number; max?: number; features?: string[] }
      | undefined;
    return {
      reachable: true,
      health: {
        status: "ok",
        service: body.service,
        ...(typeof body.version === "string" ? { version: body.version } : {}),
        ...(typeof body.hostId === "string" ? { hostId: body.hostId } : {}),
        ...(typeof body.pid === "number" ? { pid: body.pid } : {}),
        ...(typeof body.coreVersion === "string"
          ? { coreVersion: body.coreVersion }
          : {}),
        ...(protocol &&
        typeof protocol.min === "number" &&
        typeof protocol.max === "number" &&
        Array.isArray(protocol.features)
          ? {
              protocol: {
                min: protocol.min,
                max: protocol.max,
                features: protocol.features.map(String),
              },
            }
          : {}),
      },
    };
  } catch {
    return { reachable: true, foreign: true };
  }
}

export async function probeReady(
  url: string,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const response = await fetch(`${url}/ready`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: string };
    return body.status === "ready";
  } catch {
    return false;
  }
}

export interface EnsureHostConfigOptions {
  /** Explicit `--port`; collision fails (strict). */
  port?: number;
  host?: string;
}

/**
 * Load or create `host.json`. On first automatic setup, prefer 8787; when that
 * port is foreign, pick a free loopback port, persist it, and return
 * `portSelected: true` so the caller can print it.
 */
export async function ensureHostConfig(
  paths: HostPaths,
  options: EnsureHostConfigOptions = {},
): Promise<{ config: HostConfigFile; created: boolean; portSelected: boolean }> {
  await ensureHostLayout(paths);
  const existing = await readHostConfig(paths);
  if (existing) {
    if (options.port !== undefined && options.port !== existing.port) {
      // Explicit port on an existing Host updates and persists.
      const updated = { ...existing, port: options.port };
      if (!(await portBindable(updated.host, updated.port))) {
        const probe = await probeHostHealth(hostUrl(updated));
        if (!probe.health || probe.health.hostId !== updated.hostId) {
          throw new CliError(
            `Port ${updated.port} on ${updated.host} is in use by another process. Choose a free port with "nylorun runtime up --port <n>".`,
            4,
          );
        }
      }
      await writeHostConfig(paths, updated);
      return { config: updated, created: false, portSelected: false };
    }
    return { config: existing, created: false, portSelected: false };
  }

  const host = options.host ?? setting("HOST") ?? DEFAULT_HOST;
  let port = options.port ?? DEFAULT_PORT;
  let portSelected = false;

  if (options.port !== undefined) {
    if (!(await portBindable(host, port))) {
      throw new CliError(
        `Port ${port} on ${host} is in use by another process. Choose a free port with "nylorun runtime up --port <n>".`,
        4,
      );
    }
  } else {
    const free = await portBindable(host, port);
    if (!free) {
      const probe = await probeHostHealth(hostUrl({ host, port }));
      // Occupied by a foreign process or another Host → pick a free port.
      if (probe.foreign || probe.health || !free) {
        port = await findFreeLoopbackPort(host);
        portSelected = true;
      }
    }
  }

  const config: HostConfigFile = {
    hostId: newHostId(),
    host,
    port,
  };
  await writeHostConfig(paths, config);
  return { config, created: true, portSelected };
}

export function credentialsMode(paths: HostPaths): number | undefined {
  try {
    return statSync(paths.credentials).mode & 0o777;
  } catch {
    return undefined;
  }
}

/** Sync mkdir used by install before async paths are ready. */
export function ensureDirSync(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
}

export function writeFileSyncAtomic(
  path: string,
  contents: string,
  mode = 0o600,
): void {
  const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(temporary, contents, { mode });
  renameSync(temporary, path);
}
