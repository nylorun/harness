import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import {
  openSync,
  closeSync,
  statSync,
  renameSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readFile, open } from "node:fs/promises";
import {
  clearState,
  ensureDataDir,
  probeHealth,
  readState,
  writeState,
  type RuntimeState,
  type Scope,
} from "./scope.js";
import { CliError } from "./errors.js";
import { localCredentials } from "./project-runner.js";

const require = createRequire(import.meta.url);
const READY_TIMEOUT_MS = 20_000;
const LOG_LIMIT_BYTES = 8 * 1024 * 1024;

export type HostState =
  | "running"
  | "stopped"
  | "stale"
  | "unhealthy"
  | "pid-recycled"
  | "port-conflict";

export interface Status {
  state: HostState;
  scope: Scope;
  runtime?: RuntimeState;
  version?: string;
  scopeId?: string;
  pid?: number;
}

/**
 * Derived from the resolved server entry rather than a "./package.json" export, so the version
 * is readable for every installed Runtime — including one too old to declare that export,
 * which is exactly when skew detection matters.
 */
export const cliRuntimeVersion = (): string | undefined => {
  try {
    return require("@nylorun/runtime/package.json").version as string;
  } catch {
    /* fall through to the entry-relative read */
  }
  try {
    let directory = dirname(require.resolve("@nylorun/runtime/server"));
    for (let depth = 0; depth < 5; depth += 1) {
      const candidate = join(directory, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8"));
        if (pkg.name === "@nylorun/runtime") return pkg.version as string;
      }
      directory = dirname(directory);
    }
  } catch {
    /* an unresolvable Runtime is reported elsewhere */
  }
  return undefined;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the pid exists but belongs to another user; only ESRCH proves it is gone.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};

/** A squatter that accepts connections without answering /health is still a port conflict. */
async function bindable(host: string, port: number): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

export async function hostStatus(scope: Scope): Promise<Status> {
  const runtime = await readState(scope);
  const probe = await probeHealth(scope.url);
  const ours =
    probe.health !== undefined &&
    (runtime?.scopeId === undefined ||
      probe.health.scopeId === undefined ||
      probe.health.scopeId === runtime.scopeId);
  const common = {
    scope,
    ...(runtime ? { runtime } : {}),
    ...(probe.health?.version ? { version: probe.health.version } : {}),
    ...(probe.health?.scopeId ? { scopeId: probe.health.scopeId } : {}),
    ...(probe.health?.pid ? { pid: probe.health.pid } : {}),
  };
  if (probe.foreign) return { state: "port-conflict", ...common };
  if (probe.health && ours) return { state: "running", ...common };
  if (probe.health && !ours) return { state: "port-conflict", ...common };
  if (runtime && alive(runtime.pid)) return { state: "unhealthy", ...common };
  if (!(await bindable(scope.host, scope.port)))
    return { state: "port-conflict", ...common };
  if (!runtime) return { state: "stopped", ...common };
  return { state: "stale", ...common };
}

function rotateLog(path: string): void {
  try {
    if (statSync(path).size > LOG_LIMIT_BYTES) renameSync(path, `${path}.1`);
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

export async function startHost(
  scope: Scope,
  options: { foreground?: boolean; restart?: boolean } = {}
): Promise<Status> {
  await ensureDataDir(scope);
  if (options.restart) await stopHost(scope);
  const status = await hostStatus(scope);
  if (status.state === "running" && !options.foreground) return status;
  if (status.state === "port-conflict") throw portConflict(scope, status);
  if (status.state === "unhealthy")
    throw new CliError(
      `A process for ${scope.label} is running (pid ${status.runtime?.pid}) but is not answering ${scope.url}. Inspect it with "nylorun logs", then stop it with "nylorun down".`,
      1
    );
  if (status.state === "stale") await clearState(scope);

  const credentials = await localCredentials(scope.credentialsPath);
  const entry = require.resolve("@nylorun/runtime/server");
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: scope.host,
    PORT: String(scope.port),
    NYLORUN_PROJECT_PROVIDER: "1",
    NYLORUN_SERVER_KEY: credentials.serverKey,
    NYLORUN_SQLITE_PATH: scope.sqlitePath,
  };
  // Executor scopes are no longer handed to the process at startup: the host outlives any one
  // project run and learns its executors through PUT /v1/executors.
  delete environment.NYLORUN_EXECUTORS_JSON;

  if (options.foreground) {
    const child = spawn(process.execPath, [entry], {
      env: environment,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    await awaitReady(child, scope, "");
    const ready = await recordState(scope, child.pid!);
    const stop = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    const code = await new Promise<number>((resolve) =>
      child.once("exit", (value, signal) =>
        resolve(value ?? (signal === "SIGINT" ? 130 : 143))
      )
    );
    await clearState(scope);
    if (code) throw new CliError(`The Runtime exited (${code}).`, code);
    return ready;
  }

  rotateLog(scope.logPath);
  const fd = openSync(scope.logPath, "a", 0o600);
  try {
    const child = spawn(process.execPath, [entry], {
      detached: process.platform !== "win32",
      windowsHide: true,
      cwd: scope.dataDir,
      env: environment,
      stdio: ["ignore", fd, fd, "ipc"],
    });
    await awaitReady(child, scope, scope.logPath);
    child.disconnect();
    child.unref();
    return await recordState(scope, child.pid!);
  } finally {
    closeSync(fd);
  }
}

function portConflict(scope: Scope, status: Status): CliError {
  if (status.scopeId)
    return new CliError(
      `Port ${scope.port} is already serving a different nylorun scope (${status.scopeId}). Start this one elsewhere with "nylorun up --port <n>", or stop the other from its project with "nylorun down".`,
      4
    );
  return new CliError(
    `Port ${scope.port} on ${scope.host} is in use by another process. Start ${scope.label} elsewhere with "nylorun up --port <n>".`,
    4
  );
}

async function awaitReady(
  child: ChildProcess,
  scope: Scope,
  logPath: string
): Promise<void> {
  // The IPC message is the fast path and the only way to see an early crash; /health is the
  // authority, so a host that ever stops sending the message still starts correctly.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new CliError(
          `The Runtime for ${scope.label} did not start within 20 seconds. See "nylorun logs".`,
          7
        )
      );
    }, READY_TIMEOUT_MS);
    const onMessage = (message: unknown) => {
      if ((message as { type?: string })?.type !== "ready") return;
      cleanup();
      resolve();
    };
    const onExit = async (code: number | null) => {
      cleanup();
      const tail = logPath ? await logTail(logPath) : "";
      reject(
        new CliError(
          `The Runtime for ${scope.label} exited (${code}).${tail ? `\n${tail}` : ""}`,
          7
        )
      );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const probe = await probeHealth(scope.url);
    if (probe.health) return;
    if (Date.now() > deadline)
      throw new CliError(
        `The Runtime for ${scope.label} started but did not answer ${scope.url}. See "nylorun logs".`,
        7
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function recordState(scope: Scope, pid: number): Promise<Status> {
  const probe = await probeHealth(scope.url);
  const state: RuntimeState = {
    pid,
    host: scope.host,
    port: scope.port,
    url: scope.url,
    sqlitePath: scope.sqlitePath,
    logPath: scope.logPath,
    startedAt: new Date().toISOString(),
    ...(probe.health?.scopeId ? { scopeId: probe.health.scopeId } : {}),
    ...(probe.health?.version ? { runtimeVersion: probe.health.version } : {}),
    ...(cliRuntimeVersion() ? { cliVersion: cliRuntimeVersion()! } : {}),
  };
  await writeState(scope, state);
  return {
    state: "running",
    scope,
    runtime: state,
    pid,
    ...(probe.health?.version ? { version: probe.health.version } : {}),
    ...(probe.health?.scopeId ? { scopeId: probe.health.scopeId } : {}),
  };
}

export async function stopHost(
  scope: Scope,
  options: { timeoutMs?: number } = {}
): Promise<"stopped" | "not-running"> {
  const status = await hostStatus(scope);
  const pid = status.runtime?.pid ?? status.pid;
  if (status.state === "stopped" || status.state === "stale" || !pid) {
    await clearState(scope);
    return "not-running";
  }
  if (status.state === "port-conflict") throw portConflict(scope, status);
  // SIGTERM the process rather than the group: the Runtime's own shutdown is what closes
  // SQLite cleanly and tears down MCP children.
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      await clearState(scope);
      return "stopped";
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    if (process.platform === "win32") process.kill(pid);
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  await clearState(scope);
  return "stopped";
}

export interface EnsureOptions {
  autostart: boolean;
  quiet?: boolean;
}

export async function ensureRuntime(
  scope: Scope,
  options: EnsureOptions
): Promise<Status> {
  const status = await hostStatus(scope);
  if (status.state === "running") {
    assertCompatible(scope, status);
    return status;
  }
  if (status.state === "port-conflict") throw portConflict(scope, status);
  if (status.state === "unhealthy")
    throw new CliError(
      `A process for ${scope.label} is running (pid ${status.runtime?.pid}) but is not answering ${scope.url}. See "nylorun logs".`,
      1
    );
  if (!options.autostart)
    throw new CliError(
      `No Runtime is listening at ${scope.url} for ${scope.label}. Start one with "nylorun up", or drop --no-autostart.`,
      6
    );
  const started = await startHost(scope);
  if (!options.quiet)
    console.log(
      `Started the Runtime for ${scope.label} at ${scope.url} (pid ${started.pid}). It stays running; stop it with "nylorun down".`
    );
  assertCompatible(scope, started);
  return started;
}

/**
 * A daemon from an older install would reject executor registration with a bare 404, so the
 * commands that depend on that route fail early with the remedy instead.
 */
export function assertCompatible(scope: Scope, status: Status): void {
  const expected = cliRuntimeVersion();
  if (!expected) return;
  if (!status.version)
    throw new CliError(
      `The Runtime serving ${scope.url} predates executor registration. Restart it with "nylorun runtime start --restart".`,
      5
    );
  if (status.version !== expected)
    throw new CliError(
      `Runtime ${status.version} is serving ${scope.label}; this CLI ships ${expected}. Restart it with "nylorun runtime start --restart".`,
      5
    );
}

export function warnIncompatible(scope: Scope, status: Status): void {
  try {
    assertCompatible(scope, status);
  } catch (error) {
    console.warn(error instanceof Error ? error.message : String(error));
  }
}

export async function tailLog(
  scope: Scope,
  options: { follow: boolean; lines: number }
): Promise<void> {
  let size = 0;
  try {
    size = statSync(scope.logPath).size;
  } catch {
    throw new CliError(
      `No Runtime log for ${scope.label}. Start one with "nylorun up".`,
      3
    );
  }
  const text = await readFile(scope.logPath, "utf8");
  process.stdout.write(
    `${text.trimEnd().split("\n").slice(-options.lines).join("\n")}\n`
  );
  if (!options.follow) return;
  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
    process.once("SIGTERM", () => resolve());
    const poll = setInterval(async () => {
      let next = 0;
      try {
        next = statSync(scope.logPath).size;
      } catch {
        return;
      }
      if (next <= size) return;
      const handle = await open(scope.logPath, "r");
      const buffer = Buffer.alloc(next - size);
      await handle.read(buffer, 0, buffer.length, size);
      await handle.close();
      size = next;
      process.stdout.write(buffer.toString("utf8"));
    }, 500);
    poll.unref();
  });
}
