import { existsSync, renameSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  compareVersions,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import {
  baselineEnvironment,
  hostProcessEnvironment,
} from "../host/environment.js";
import { LauncherError } from "./errors.js";
import { ensureHostConfig } from "./ensure-config.js";
import type { HostConfigFile } from "./host-config.js";
import { writeHostConfig } from "./host-config.js";
import {
  clearHostState,
  ensureHostCredentials,
  readHostCredentials,
  readHostState,
  writeHostState,
} from "./host-state.js";
import {
  LIFECYCLE_LOCK_WAIT_MS,
  processAlive,
  withProcessLock,
  type LockOptions,
} from "./locks.js";
import { hostUrl, type HostPaths } from "./paths.js";
import { probeHostHealth, probeReady } from "./probe.js";
import type { DownResult, LauncherEvent, UpResult } from "./protocol.js";
import { assertSchemaGuard } from "./schema-guard.js";
import { forceKillHost, spawnHostProcess } from "./spawn.js";
import { status } from "./status.js";

const READY_TIMEOUT_MS = 30_000;
const LOG_LIMIT_BYTES = 10 * 1024 * 1024;
const DOWN_KILL_WAIT_MS = 30_000;
const WAIT_IDLE_DEFAULT_MS = 300_000;

export type LifecycleEmit = (event: LauncherEvent) => void;

export interface LifecycleContext {
  paths: HostPaths;
  /** Node that runs the Host: the launcher's own `process.execPath`. */
  nodeBinary: string;
  /** Host entry of this package (`dist/host/main.js`). */
  hostEntry: string;
  /** Version of this `@nylorun/runtime` package. */
  runtimeVersion: string;
  /** Highest Tenant schema this package can open. */
  tenantSchemaMax: number;
  /** Allowlisted ambient baseline (from main.ts). */
  baselineEnv: Readonly<Record<string, string | undefined>>;
  emit?: LifecycleEmit;
  fetchImpl?: typeof fetch;
  lock?: LockOptions;
  /** Injectable spawn for tests. */
  spawnHost?: typeof spawnHostProcess;
  /** Injectable signals for `run` tests. */
  onSignal?: (
    handler: (signal: NodeJS.Signals) => void,
  ) => () => void;
}

function emitProgress(
  ctx: LifecycleContext,
  phase: Extract<LauncherEvent, { type: "progress" }>["phase"],
  message?: string,
): void {
  ctx.emit?.({
    type: "progress",
    phase,
    ...(message ? { message } : {}),
  });
}

function rotateLog(path: string): void {
  try {
    if (statSync(path).size > LOG_LIMIT_BYTES) {
      renameSync(path, `${path}.1`);
    }
  } catch {
    /* no log yet */
  }
}

async function logTail(path: string, lines = 40): Promise<string> {
  try {
    const text = await readFile(path, "utf8");
    return text.trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Refuse to start an older Runtime than the one that last ran this Host root,
 * unless the caller confirmed the downgrade.
 */
function assertNotDowngrade(
  recorded: string | undefined,
  target: string,
  allowDowngrade: boolean | undefined,
): void {
  if (!recorded || allowDowngrade) return;
  if (compareVersions(target, recorded) >= 0) return;
  throw new LauncherError(
    "downgrade_refused",
    `This Host root last ran Runtime ${recorded}; the installed Runtime is ${target}.`,
    `Install ${recorded} or newer (npm install --global @nylorun/runtime@${recorded}), or pass --allow-downgrade after confirming Tenants can open on the older schema.`,
  );
}

async function awaitHostReady(
  url: string,
  logPath: string,
  childPid: number | undefined,
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (childPid !== undefined && !processAlive(childPid)) {
      const tail = await logTail(logPath);
      throw new LauncherError(
        "host_start_failed",
        `The Runtime Host exited before becoming ready.${tail ? `\n${tail}` : ""}`,
        'Inspect "nylorun-runtime logs" and retry up.',
        { logExcerpt: tail },
      );
    }
    if (await probeReady(url, 500)) return;
    const probe = await probeHostHealth(url, 500);
    if (probe.health) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  const tail = await logTail(logPath);
  throw new LauncherError(
    "host_start_failed",
    `The Runtime Host did not become ready within 30 seconds.${tail ? `\n${tail}` : ""}`,
    'Inspect "nylorun-runtime logs" and retry up.',
    { logExcerpt: tail },
  );
}

function adminHeaders(adminKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${adminKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    Accept: "application/json",
  };
}

interface AdminAggregate {
  runningSessions: number;
  connectedExecutors: number;
  pendingActions: number;
  uncertainEffects: number;
}

async function fetchAdminAggregate(
  url: string,
  adminKey: string,
  fetchImpl: typeof fetch,
): Promise<AdminAggregate | undefined> {
  try {
    const response = await fetchImpl(`${url}/v1/admin/status`, {
      headers: adminHeaders(adminKey),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as {
      aggregate?: AdminAggregate;
    };
    return body.aggregate;
  } catch {
    return undefined;
  }
}

async function requestShutdown(
  url: string,
  adminKey: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  try {
    await fetchImpl(`${url}/v1/admin/host/shutdown`, {
      method: "POST",
      headers: adminHeaders(adminKey),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* fall through to signal/kill */
  }
}

export interface UpOptions {
  port?: number;
  /** Foreground mode used by `run`. */
  foreground?: boolean;
  /** Start even when this Runtime is older than the one that last ran. */
  allowDowngrade?: boolean;
}

/**
 * Start the local Host (D§9.6). Never restarts a running Host.
 */
export async function up(
  ctx: LifecycleContext,
  options: UpOptions = {},
): Promise<UpResult> {
  return withProcessLock(
    ctx.paths.lifecycleLock,
    ctx.lock?.waitMs ?? LIFECYCLE_LOCK_WAIT_MS,
    async () => upLocked(ctx, options),
    ctx.lock,
  );
}

async function upLocked(
  ctx: LifecycleContext,
  options: UpOptions,
): Promise<UpResult> {
  const { config } = await ensureHostConfig(ctx.paths, {
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
  await ensureHostCredentials(ctx.paths);

  const before = await status(ctx.paths, ctx.runtimeVersion);

  if (before.state === "running" && !options.foreground) {
    return {
      url: before.url!,
      hostId: before.hostId ?? config.hostId,
      pid: before.pid!,
      version: before.version ?? before.runtimeVersion ?? "unknown",
      started: false,
    };
  }
  if (before.state === "foreign-port") {
    throw new LauncherError(
      "foreign_port",
      `Port ${config.port} on ${config.host} is in use by another process.`,
      'Choose a free port with "nylorun-runtime up --port <n>", or stop the other process.',
    );
  }
  if (before.state === "unresponsive") {
    throw new LauncherError(
      "host_unresponsive",
      `A Host process is running (pid ${before.pid}) but is not answering ${before.url}.`,
      'Inspect it with "nylorun-runtime logs", then stop it with "nylorun-runtime down".',
      { pid: before.pid },
    );
  }

  // Clear stale state before start.
  const stateFile = await readHostState(ctx.paths);
  if (stateFile && !processAlive(stateFile.pid)) {
    await clearHostState(ctx.paths);
  }

  const target = ctx.runtimeVersion;
  assertNotDowngrade(
    typeof config.runtimeVersion === "string" ? config.runtimeVersion : undefined,
    target,
    options.allowDowngrade,
  );
  assertSchemaGuard(ctx.paths, ctx.tenantSchemaMax);

  const entry = ctx.hostEntry;
  const nodeBinary = ctx.nodeBinary;
  if (!existsSync(entry)) {
    throw new LauncherError(
      "host_start_failed",
      `The installed Runtime has no Host entry at ${entry}.`,
      `Reinstall it: npm install --global @nylorun/runtime@${target}`,
    );
  }

  const baseline = baselineEnvironment(ctx.baselineEnv);
  const environment = hostProcessEnvironment(baseline, config, {
    root: ctx.paths.root,
    home: ctx.paths.home,
    tmp: ctx.paths.tmp,
  });
  const devModel = ctx.baselineEnv.NYLORUN_DEV_MODEL?.trim();
  if (devModel) environment.NYLORUN_DEV_MODEL = devModel;

  const spawnFn = ctx.spawnHost ?? spawnHostProcess;
  const url = hostUrl(config);

  if (options.foreground) {
    emitProgress(ctx, "start");
    const child = spawnFn({
      nodeBinary,
      entry,
      environment,
      cwd: ctx.paths.home,
      detached: false,
    });
    await awaitHostReady(url, ctx.paths.log, child.pid);
    await recordReady(ctx.paths, config, child.pid!, target, entry);
    return {
      url,
      hostId: config.hostId,
      pid: child.pid!,
      version: target,
      started: true,
    };
  }

  rotateLog(ctx.paths.log);
  emitProgress(ctx, "start");
  const child = spawnFn({
    nodeBinary,
    entry,
    environment,
    cwd: ctx.paths.home,
    detached: true,
    logPath: ctx.paths.log,
  });
  try {
    await awaitHostReady(url, ctx.paths.log, child.pid);
  } catch (error) {
    if (child.pid) forceKillHost(child.pid);
    throw error;
  }
  child.unref();
  await recordReady(ctx.paths, config, child.pid!, target, entry);
  return {
    url,
    hostId: config.hostId,
    pid: child.pid!,
    version: target,
    started: true,
  };
}

async function recordReady(
  paths: HostPaths,
  config: HostConfigFile,
  pid: number,
  version: string,
  entry: string,
): Promise<void> {
  const url = hostUrl(config);
  await writeHostState(paths, {
    pid,
    startedAt: new Date().toISOString(),
    version,
    entry,
    url,
  });
  // runtimeVersion changes only after ready (D§9.6 / D§9.8).
  await writeHostConfig(paths, {
    ...config,
    format: 1,
    runtimeVersion: version,
  });
}

export interface DownOptions {
  wait?: boolean;
  force?: boolean;
  timeoutMs?: number;
}

/**
 * Stop the local Host (D§9.7).
 */
export async function down(
  ctx: LifecycleContext,
  options: DownOptions = {},
): Promise<DownResult> {
  return withProcessLock(
    ctx.paths.lifecycleLock,
    ctx.lock?.waitMs ?? LIFECYCLE_LOCK_WAIT_MS,
    async () => downLocked(ctx, options),
    ctx.lock,
  );
}

async function downLocked(
  ctx: LifecycleContext,
  options: DownOptions,
): Promise<DownResult> {
  const current = await status(ctx.paths, ctx.runtimeVersion);
  const stateFile = await readHostState(ctx.paths);
  const pid = current.pid ?? stateFile?.pid;

  if (
    current.state === "absent" ||
    current.state === "stopped" ||
    (!pid && current.state !== "running" && current.state !== "unresponsive")
  ) {
    await clearHostState(ctx.paths);
    return { stopped: false };
  }
  if (current.state === "foreign-port") {
    throw new LauncherError(
      "foreign_port",
      `Port is serving a foreign process; refusing to stop it.`,
      "Stop the other process manually, or use a different --port.",
    );
  }

  const fetchImpl = ctx.fetchImpl ?? fetch;
  const credentials = await readHostCredentials(ctx.paths);
  const url = current.url ?? stateFile?.url;

  if (!options.force && credentials && url && current.state === "running") {
    emitProgress(ctx, "wait");
    let aggregate = await fetchAdminAggregate(
      url,
      credentials.adminKey,
      fetchImpl,
    );
    if (
      aggregate &&
      (aggregate.runningSessions > 0 || aggregate.connectedExecutors > 0)
    ) {
      if (!options.wait) {
        throw new LauncherError(
          "active_work",
          `Host has ${aggregate.runningSessions} running session(s) and ${aggregate.connectedExecutors} connected executor(s).`,
          'Pass --wait to drain, or --force to stop immediately.',
          { aggregate },
        );
      }
      const timeoutMs = options.timeoutMs ?? WAIT_IDLE_DEFAULT_MS;
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        aggregate = await fetchAdminAggregate(
          url,
          credentials.adminKey,
          fetchImpl,
        );
        if (
          !aggregate ||
          (aggregate.runningSessions === 0 &&
            aggregate.connectedExecutors === 0)
        ) {
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (
        aggregate &&
        (aggregate.runningSessions > 0 || aggregate.connectedExecutors > 0)
      ) {
        throw new LauncherError(
          "active_work",
          `Timed out waiting for the Host to become idle.`,
          "Retry with a longer --timeout, or pass --force.",
          { aggregate },
        );
      }
    }
  }

  emitProgress(ctx, "stop");
  if (credentials && url) {
    await requestShutdown(url, credentials.adminKey, fetchImpl);
  }
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + DOWN_KILL_WAIT_MS;
    while (Date.now() < deadline) {
      if (!processAlive(pid)) {
        await clearHostState(ctx.paths);
        return { stopped: true };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    forceKillHost(pid);
  }
  await clearHostState(ctx.paths);
  return { stopped: true };
}

export interface RestartOptions {
  allowDowngrade?: boolean;
  wait?: boolean;
  force?: boolean;
  timeoutMs?: number;
  port?: number;
}

/**
 * Check the installed Runtime can take over, stop, start (D§9.8).
 * runtimeVersion updates only after ready.
 */
export async function restart(
  ctx: LifecycleContext,
  options: RestartOptions = {},
): Promise<UpResult> {
  return withProcessLock(
    ctx.paths.lifecycleLock,
    ctx.lock?.waitMs ?? LIFECYCLE_LOCK_WAIT_MS,
    async () => {
      const config = (await ensureHostConfig(ctx.paths, {
        ...(options.port !== undefined ? { port: options.port } : {}),
      })).config;
      const target = ctx.runtimeVersion;
      // Check before touching the running Host.
      assertNotDowngrade(
        typeof config.runtimeVersion === "string"
          ? config.runtimeVersion
          : undefined,
        target,
        options.allowDowngrade,
      );
      assertSchemaGuard(ctx.paths, ctx.tenantSchemaMax);

      await downLocked(ctx, {
        wait: options.wait,
        force: options.force ?? true,
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      });

      try {
        return await upLocked(ctx, {
          allowDowngrade: true,
          ...(options.port !== undefined ? { port: options.port } : {}),
        });
      } catch (error) {
        if (error instanceof LauncherError && error.code === "host_start_failed") {
          const tail =
            typeof error.details === "object" &&
            error.details &&
            "logExcerpt" in error.details
              ? String(
                  (error.details as { logExcerpt?: string }).logExcerpt ?? "",
                )
              : await logTail(ctx.paths.log);
          throw new LauncherError(
            "upgrade_failed",
            `Failed to start Runtime ${target} after stop.${tail ? `\n${tail}` : ""}`,
            "The previous Host is stopped. Fix the issue, or reinstall the last good version (npm install --global @nylorun/runtime@<version>) and run up.",
            { version: target, logExcerpt: tail },
          );
        }
        throw error;
      }
    },
    ctx.lock,
  );
}

/**
 * Foreground Host: print up result once ready; stop on SIGINT/SIGTERM (D§9.3).
 */
export async function run(
  ctx: LifecycleContext,
  options: {
    port?: number;
    allowDowngrade?: boolean;
    onReady?: (result: UpResult) => void;
  } = {},
): Promise<UpResult> {
  return withProcessLock(
    ctx.paths.lifecycleLock,
    ctx.lock?.waitMs ?? LIFECYCLE_LOCK_WAIT_MS,
    async () => {
      const result = await upLocked(ctx, {
        port: options.port,
        allowDowngrade: options.allowDowngrade,
        foreground: true,
      });
      options.onReady?.(result);

      const state = await readHostState(ctx.paths);
      const pid = state?.pid ?? result.pid;

      await new Promise<void>((resolvePromise) => {
        let settled = false;
        const finish = async () => {
          if (settled) return;
          settled = true;
          cleanup();
          clearInterval(poll);
          try {
            if (pid) process.kill(pid, "SIGTERM");
          } catch {
            /* gone */
          }
          const deadline = Date.now() + DOWN_KILL_WAIT_MS;
          while (Date.now() < deadline && pid && processAlive(pid)) {
            await new Promise((r) => setTimeout(r, 100));
          }
          if (pid && processAlive(pid)) forceKillHost(pid);
          await clearHostState(ctx.paths);
          resolvePromise();
        };
        const handler = () => {
          void finish();
        };
        let remove: () => void;
        if (ctx.onSignal) {
          remove = ctx.onSignal(handler);
        } else {
          process.on("SIGINT", handler);
          process.on("SIGTERM", handler);
          remove = () => {
            process.off("SIGINT", handler);
            process.off("SIGTERM", handler);
          };
        }
        const cleanup = () => remove();
        const poll = setInterval(() => {
          if (pid && !processAlive(pid)) {
            void (async () => {
              if (settled) return;
              settled = true;
              cleanup();
              clearInterval(poll);
              await clearHostState(ctx.paths);
              resolvePromise();
            })();
          }
        }, 250);
        poll.unref();
      });

      return result;
    },
    ctx.lock,
  );
}
