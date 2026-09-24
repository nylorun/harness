import { spawn, type ChildProcess } from "node:child_process";
import {
  closeSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  existsSync,
} from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.js";
import { baselineEnv } from "./baseline.js";
import { hostProcessEnvironment } from "./environment.js";
import { assertHostCompatible, warnHostIncompatible } from "./compatibility.js";
import {
  fetchAdminHost,
  waitForIdle,
  type AdminHostStatus,
} from "./admin-client.js";
import {
  cliRuntimePackageVersion,
  ensureInstalled,
  type EnsureInstalledOptions,
} from "./install.js";
import {
  clearHostState,
  ensureHostConfig,
  ensureHostCredentials,
  hostPaths,
  hostUrl,
  portBindable,
  probeHostHealth,
  probeReady,
  readHostConfig,
  readHostCredentials,
  readHostState,
  resolveHostRoot,
  writeHostState,
  type HostConfigFile,
  type HostPaths,
  type HostStateFile,
} from "./root.js";

const READY_TIMEOUT_MS = 20_000;
const LOG_LIMIT_BYTES = 8 * 1024 * 1024;

export type HostProcessState =
  | "running"
  | "stopped"
  | "stale"
  | "unhealthy"
  | "port-conflict";

export interface HostStatus {
  state: HostProcessState;
  root: string;
  url: string;
  config?: HostConfigFile;
  runtime?: HostStateFile;
  version?: string;
  hostId?: string;
  pid?: number;
  protocol?: { min: number; max: number; features: readonly string[] };
  tenants?: AdminHostStatus["tenants"];
  aggregate?: AdminHostStatus["aggregate"];
}

export interface LifecycleDeps {
  installer?: EnsureInstalledOptions["installer"];
  spawnHost?: typeof spawnHostProcess;
  fetchImpl?: typeof fetch;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
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

export function resolvePaths(root = resolveHostRoot()): HostPaths {
  return hostPaths(root);
}

export async function hostStatus(
  root = resolveHostRoot(),
  deps: LifecycleDeps = {},
): Promise<HostStatus> {
  const paths = hostPaths(root);
  const config = await readHostConfig(paths);
  const runtime = await readHostState(paths);
  const url = config
    ? hostUrl(config)
    : runtime?.url ?? `http://127.0.0.1:8787`;
  const probe = await probeHostHealth(url);
  const ours =
    probe.health !== undefined &&
    (config === undefined ||
      probe.health.hostId === undefined ||
      probe.health.hostId === config.hostId);

  const common: HostStatus = {
    state: "stopped",
    root: paths.root,
    url,
    ...(config ? { config } : {}),
    ...(runtime ? { runtime } : {}),
    ...(probe.health?.version ? { version: probe.health.version } : {}),
    ...(probe.health?.hostId ? { hostId: probe.health.hostId } : {}),
    ...(probe.health?.pid ? { pid: probe.health.pid } : {}),
    ...(probe.health?.protocol ? { protocol: probe.health.protocol } : {}),
  };

  if (probe.foreign) return { ...common, state: "port-conflict" };
  if (probe.health && ours) {
    const enriched = await enrichWithAdmin(common, paths, deps);
    return { ...enriched, state: "running" };
  }
  if (probe.health && !ours) return { ...common, state: "port-conflict" };
  if (runtime && alive(runtime.pid)) return { ...common, state: "unhealthy" };
  if (config && !(await portBindable(config.host, config.port))) {
    return { ...common, state: "port-conflict" };
  }
  if (!runtime) return { ...common, state: "stopped" };
  return { ...common, state: "stale" };
}

async function enrichWithAdmin(
  status: HostStatus,
  paths: HostPaths,
  deps: LifecycleDeps,
): Promise<HostStatus> {
  const credentials = await readHostCredentials(paths);
  if (!credentials || !status.url) return status;
  try {
    const admin = await fetchAdminHost({
      url: status.url,
      adminKey: credentials.adminKey,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });
    return {
      ...status,
      tenants: admin.tenants,
      aggregate: admin.aggregate,
      version: admin.version || status.version,
      hostId: admin.hostId || status.hostId,
      protocol: admin.protocol || status.protocol,
      pid: admin.pid || status.pid,
    };
  } catch {
    return status;
  }
}

function portConflict(status: HostStatus): CliError {
  if (status.hostId && status.config && status.hostId !== status.config.hostId) {
    return new CliError(
      `Port ${status.config.port} is already serving a different Runtime Host (${status.hostId}). Start this one elsewhere with "nylorun runtime up --port <n>", or stop the other with "nylorun runtime down".`,
      4,
    );
  }
  const port = status.config?.port ?? new URL(status.url).port;
  const host = status.config?.host ?? "127.0.0.1";
  return new CliError(
    `Port ${port} on ${host} is in use by another process. Start the Host elsewhere with "nylorun runtime up --port <n>".`,
    4,
  );
}

export interface UpOptions {
  port?: number;
  foreground?: boolean;
  root?: string;
}

export async function up(
  options: UpOptions = {},
  deps: LifecycleDeps = {},
): Promise<{
  status: HostStatus;
  created: boolean;
  portSelected: boolean;
}> {
  const paths = hostPaths(options.root ?? resolveHostRoot());
  const { config, created, portSelected } = await ensureHostConfig(paths, {
    ...(options.port !== undefined ? { port: options.port } : {}),
  });
  await ensureHostCredentials(paths);

  const before = await hostStatus(paths.root, deps);
  if (before.state === "running" && !options.foreground) {
    await warnHostIncompatible(before.url);
    return { status: before, created, portSelected };
  }
  if (before.state === "port-conflict") throw portConflict(before);
  if (before.state === "unhealthy") {
    throw new CliError(
      `A Host process is running (pid ${before.runtime?.pid}) but is not answering ${before.url}. Inspect it with "nylorun runtime logs", then stop it with "nylorun runtime down".`,
      1,
    );
  }
  if (before.state === "stale") await clearHostState(paths);

  const installed = await ensureInstalled(paths, {
    ...(deps.installer ? { installer: deps.installer } : {}),
  });
  const spawnFn = deps.spawnHost ?? spawnHostProcess;
  const environment = hostProcessEnvironment(baselineEnv(), config, {
    home: paths.home,
    tmp: paths.tmp,
    root: paths.root,
  });

  if (options.foreground) {
    const child = spawnFn({
      entry: installed.entry,
      environment,
      cwd: paths.home,
      detached: false,
      logPath: undefined,
    });
    await awaitReady(child, hostUrl(config), "");
    const ready = await recordState(paths, config, child.pid!, installed);
    const stop = (signal: NodeJS.Signals) => child.kill(signal);
    process.on("SIGINT", () => stop("SIGINT"));
    process.on("SIGTERM", () => stop("SIGTERM"));
    const code = await new Promise<number>((resolvePromise) =>
      child.once("exit", (value, signal) =>
        resolvePromise(value ?? (signal === "SIGINT" ? 130 : 143)),
      ),
    );
    await clearHostState(paths);
    if (code) throw new CliError(`The Runtime Host exited (${code}).`, code);
    return { status: ready, created, portSelected };
  }

  rotateLog(paths.log);
  const child = spawnFn({
    entry: installed.entry,
    environment,
    cwd: paths.home,
    detached: true,
    logPath: paths.log,
  });
  await awaitReady(child, hostUrl(config), paths.log);
  child.disconnect?.();
  child.unref();
  const status = await recordState(paths, config, child.pid!, installed);
  return { status, created, portSelected };
}

export interface SpawnHostInput {
  entry: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  detached: boolean;
  logPath?: string;
}

export function spawnHostProcess(input: SpawnHostInput): ChildProcess {
  if (input.logPath) {
    const fd = openSync(input.logPath, "a", 0o600);
    try {
      const child = spawn(process.execPath, [input.entry], {
        detached: input.detached && process.platform !== "win32",
        windowsHide: true,
        cwd: input.cwd,
        env: input.environment,
        stdio: ["ignore", fd, fd, "ipc"],
      });
      child.once("exit", () => {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      });
      return child;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  return spawn(process.execPath, [input.entry], {
    cwd: input.cwd,
    env: input.environment,
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
}

async function awaitReady(
  child: ChildProcess,
  url: string,
  logPath: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new CliError(
          `The Runtime Host did not start within 20 seconds. See "nylorun runtime logs".`,
          7,
        ),
      );
    }, READY_TIMEOUT_MS);
    const onMessage = (message: unknown) => {
      if ((message as { type?: string })?.type !== "ready") return;
      cleanup();
      resolvePromise();
    };
    const onExit = async (code: number | null) => {
      cleanup();
      const tail = logPath ? await logTail(logPath) : "";
      reject(
        new CliError(
          `The Runtime Host exited (${code}).${tail ? `\n${tail}` : ""}`,
          7,
        ),
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
    if (await probeReady(url)) return;
    const probe = await probeHostHealth(url);
    // Prefer /ready; accept /health when /ready is absent (stub Hosts, transitional).
    if (probe.health) return;
    if (Date.now() > deadline) {
      throw new CliError(
        `The Runtime Host started but did not answer ${url}/ready. See "nylorun runtime logs".`,
        7,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function recordState(
  paths: HostPaths,
  config: HostConfigFile,
  pid: number,
  installed: { entry: string; version: string },
): Promise<HostStatus> {
  const url = hostUrl(config);
  const probe = await probeHostHealth(url);
  const state: HostStateFile = {
    pid,
    startedAt: new Date().toISOString(),
    version: installed.version,
    entry: installed.entry,
    url,
  };
  await writeHostState(paths, state);
  return {
    state: "running",
    root: paths.root,
    url,
    config,
    runtime: state,
    pid,
    ...(probe.health?.version ? { version: probe.health.version } : { version: installed.version }),
    ...(probe.health?.hostId ? { hostId: probe.health.hostId } : { hostId: config.hostId }),
    ...(probe.health?.protocol ? { protocol: probe.health.protocol } : {}),
  };
}

export interface DownOptions {
  root?: string;
  force?: boolean;
  wait?: boolean;
  timeoutMs?: number;
}

export async function down(
  options: DownOptions = {},
  deps: LifecycleDeps = {},
): Promise<"stopped" | "not-running"> {
  const paths = hostPaths(options.root ?? resolveHostRoot());
  const status = await hostStatus(paths.root, deps);
  const pid = status.runtime?.pid ?? status.pid;
  if (status.state === "stopped" || status.state === "stale" || !pid) {
    await clearHostState(paths);
    return "not-running";
  }
  if (status.state === "port-conflict") throw portConflict(status);

  if (!options.force) {
    const credentials = await readHostCredentials(paths);
    if (credentials && status.state === "running") {
      try {
        const admin = await fetchAdminHost({
          url: status.url,
          adminKey: credentials.adminKey,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        });
        const { runningSessions, connectedExecutors } = admin.aggregate;
        if (runningSessions > 0 || connectedExecutors > 0) {
          console.warn(
            `Host has ${runningSessions} running session(s) and ${connectedExecutors} connected executor(s).`,
          );
          if (options.wait) {
            await waitForIdle({
              url: status.url,
              adminKey: credentials.adminKey,
              timeoutMs: options.timeoutMs,
              ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
            });
          }
        }
      } catch {
        /* proceed to signal */
      }
    }
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    if (!alive(pid)) {
      await clearHostState(paths);
      // host.json survives.
      return "stopped";
    }
    await new Promise((r) => setTimeout(r, 100));
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
  await clearHostState(paths);
  return "stopped";
}

export interface RestartOptions {
  port?: number;
  root?: string;
}

/** Install and verify the CLI's exact version before stopping the current Host. */
export async function restart(
  options: RestartOptions = {},
  deps: LifecycleDeps = {},
): Promise<{ status: HostStatus; created: boolean; portSelected: boolean }> {
  const paths = hostPaths(options.root ?? resolveHostRoot());
  await ensureInstalled(paths, {
    ...(deps.installer ? { installer: deps.installer } : {}),
  });
  await down({ root: paths.root, force: true }, deps);
  return up(
    {
      root: paths.root,
      ...(options.port !== undefined ? { port: options.port } : {}),
    },
    deps,
  );
}

/** Attached foreground Host from the installed version. */
export async function run(
  options: UpOptions = {},
  deps: LifecycleDeps = {},
): Promise<HostStatus> {
  const result = await up({ ...options, foreground: true }, deps);
  return result.status;
}

export interface StatusPrintOptions {
  json?: boolean;
  /** Hook for WS-F: print Project link `export` lines. */
  env?: boolean;
  envHook?: (status: HostStatus) => void | Promise<void>;
  root?: string;
}

export async function statusCommand(
  options: StatusPrintOptions = {},
  deps: LifecycleDeps = {},
): Promise<HostStatus> {
  const status = await hostStatus(options.root ?? resolveHostRoot(), deps);
  if (options.env) {
    if (options.envHook) await options.envHook(status);
    else {
      console.log(
        "# runtime status --env requires a Project link (nylorun dev). Coming in a later release.",
      );
    }
    return status;
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          hostId: status.hostId ?? status.config?.hostId ?? null,
          root: status.root,
          url: status.url,
          state: status.state,
          pid: status.runtime?.pid ?? status.pid ?? null,
          version: status.version ?? status.runtime?.version ?? null,
          protocol: status.protocol ?? null,
          tenants: status.tenants ?? [],
          aggregate: status.aggregate ?? null,
          startedAt: status.runtime?.startedAt ?? null,
          cliRuntimeVersion: cliRuntimePackageVersion(),
        },
        null,
        2,
      ),
    );
  } else {
    printStatus(status);
  }
  return status;
}

export function printStatus(status: HostStatus): void {
  const lines: [string, string | undefined][] = [
    ["Host", status.hostId ?? status.config?.hostId],
    ["State", status.state],
    ["URL", status.url],
    ["Root", status.root],
    [
      "PID",
      status.runtime?.pid
        ? String(status.runtime.pid)
        : status.pid
          ? String(status.pid)
          : undefined,
    ],
    ["Version", status.version ?? status.runtime?.version],
    [
      "Protocol",
      status.protocol
        ? `${status.protocol.min}–${status.protocol.max} [${status.protocol.features.join(", ")}]`
        : undefined,
    ],
    ["CLI Runtime", cliRuntimePackageVersion()],
    ["Log", join(status.root, "runtime.log")],
    ["Started", status.runtime?.startedAt],
  ];
  const width = Math.max(...lines.map(([label]) => label.length));
  for (const [label, value] of lines) {
    if (value !== undefined) console.log(`${label.padEnd(width)}  ${value}`);
  }
  if (status.tenants && status.tenants.length > 0) {
    console.log("Tenants");
    for (const tenant of status.tenants) {
      const name = tenant.name ?? "(unreadable)";
      const short = tenant.id.slice(0, 10);
      console.log(`  ${name}  ${short}…  ${tenant.state}`);
    }
  }
  if (status.aggregate) {
    console.log(
      `Aggregate  sessions=${status.aggregate.runningSessions} executors=${status.aggregate.connectedExecutors} pending=${status.aggregate.pendingActions} uncertain=${status.aggregate.uncertainEffects}`,
    );
  }
}

export interface LogsOptions {
  follow?: boolean;
  lines?: number;
  root?: string;
}

/**
 * Multiplex runtime.log and every tenants/<id>/logs/tenant.log, prefixing
 * Tenant lines with name and short id, without writing a combined file.
 */
export async function logsCommand(options: LogsOptions = {}): Promise<void> {
  const paths = hostPaths(options.root ?? resolveHostRoot());
  const lineCount = options.lines ?? 200;
  const sources = await collectLogSources(paths);

  if (sources.length === 0 || !sources.some((s) => existsSync(s.path))) {
    throw new CliError(
      `No Runtime Host log under ${paths.root}. Start one with "nylorun runtime up".`,
      3,
    );
  }

  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    const text = await readFile(source.path, "utf8");
    const slice = text.trimEnd().split("\n").slice(-lineCount);
    for (const line of slice) {
      process.stdout.write(
        source.prefix ? `${source.prefix} ${line}\n` : `${line}\n`,
      );
    }
  }

  if (!options.follow) return;

  const cursors = new Map<string, number>();
  for (const source of sources) {
    try {
      cursors.set(source.path, statSync(source.path).size);
    } catch {
      cursors.set(source.path, 0);
    }
  }

  await new Promise<void>((resolvePromise) => {
    process.once("SIGINT", () => resolvePromise());
    process.once("SIGTERM", () => resolvePromise());
    const poll = setInterval(async () => {
      for (const source of await collectLogSources(paths)) {
        let next = 0;
        try {
          next = statSync(source.path).size;
        } catch {
          continue;
        }
        const size = cursors.get(source.path) ?? 0;
        if (next <= size) {
          cursors.set(source.path, next);
          continue;
        }
        const handle = await open(source.path, "r");
        const buffer = Buffer.alloc(next - size);
        await handle.read(buffer, 0, buffer.length, size);
        await handle.close();
        cursors.set(source.path, next);
        const chunk = buffer.toString("utf8");
        for (const line of chunk.split("\n")) {
          if (line === "" && !chunk.endsWith("\n")) continue;
          if (line === "") {
            process.stdout.write("\n");
            continue;
          }
          process.stdout.write(
            source.prefix ? `${source.prefix} ${line}\n` : `${line}\n`,
          );
        }
      }
    }, 500);
    poll.unref();
  });
}

async function collectLogSources(
  paths: HostPaths,
): Promise<{ path: string; prefix?: string }[]> {
  const sources: { path: string; prefix?: string }[] = [
    { path: paths.log },
  ];
  let tenantDirs: string[] = [];
  try {
    tenantDirs = readdirSync(paths.tenants);
  } catch {
    return sources;
  }
  for (const id of tenantDirs) {
    const logPath = join(paths.tenants, id, "logs", "tenant.log");
    if (!existsSync(logPath)) continue;
    let name = id;
    try {
      const envelope = JSON.parse(
        readFileSync(join(paths.tenants, id, "tenant.json"), "utf8"),
      ) as { name?: string };
      if (typeof envelope.name === "string") name = envelope.name;
    } catch {
      /* use id */
    }
    const short = id.length > 10 ? `${id.slice(0, 10)}…` : id;
    sources.push({ path: logPath, prefix: `[${name} ${short}]` });
  }
  return sources;
}

export async function ensureHost(
  options: { autostart: boolean; quiet?: boolean; root?: string } = {
    autostart: true,
  },
  deps: LifecycleDeps = {},
): Promise<HostStatus> {
  const root = options.root ?? resolveHostRoot();
  const status = await hostStatus(root, deps);
  if (status.state === "running") {
    await assertHostCompatible(status.url);
    return status;
  }
  if (status.state === "port-conflict") throw portConflict(status);
  if (status.state === "unhealthy") {
    throw new CliError(
      `A Host process is running (pid ${status.runtime?.pid}) but is not answering ${status.url}. See "nylorun runtime logs".`,
      1,
    );
  }
  if (!options.autostart) {
    throw new CliError(
      `No Runtime Host is listening at ${status.url}. Start one with "nylorun runtime up", or drop --no-autostart.`,
      6,
    );
  }
  const started = await up({ root }, deps);
  if (!options.quiet) {
    console.log(
      `Started the Runtime Host at ${started.status.url} (pid ${started.status.pid}). It stays running; stop it with "nylorun runtime down".`,
    );
  }
  await assertHostCompatible(started.status.url);
  return started.status;
}
