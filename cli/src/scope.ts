import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { loadProjectEnvironment } from "./environment.js";

export type ScopeKind = "project" | "global";

export interface Scope {
  readonly kind: ScopeKind;
  readonly root: string;
  readonly dataDir: string;
  readonly sqlitePath: string;
  readonly credentialsPath: string;
  readonly statePath: string;
  readonly logPath: string;
  readonly pidPath: string;
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly label: string;
}

export interface RuntimeState {
  pid: number;
  host: string;
  port: number;
  url: string;
  scopeId?: string;
  runtimeVersion?: string;
  cliVersion?: string;
  sqlitePath: string;
  logPath: string;
  startedAt: string;
}

export interface ScopeRequest {
  global?: boolean;
  port?: number;
  db?: string;
  cwd?: string;
}

/** An environment variable set to the empty string means "unset", not "use an empty path". */
const setting = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
};

const globalDataDir = () => {
  const home = setting("NYLORUN_HOME");
  return home ? resolve(home) : join(homedir(), ".nylorun");
};

/**
 * The nearest `.nylorun` wins so an initialised project keeps working from a subdirectory;
 * otherwise the nearest package.json defines the project. The walk stops at the home
 * directory because `~/.nylorun` is the global data directory, never a project root.
 */
export function findProjectRoot(cwd = process.cwd()): string | undefined {
  const stop = (() => {
    try {
      return realpathSync(homedir());
    } catch {
      return homedir();
    }
  })();
  let directory = resolve(cwd);
  try {
    directory = realpathSync(directory);
  } catch {
    /* a cwd that cannot be resolved simply falls through to the global scope */
  }
  const root = parse(directory).root;
  let fallback: string | undefined;
  for (;;) {
    if (directory === stop) return undefined;
    if (existsSync(join(directory, ".nylorun"))) return directory;
    if (!fallback && existsSync(join(directory, "package.json")))
      fallback = directory;
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return fallback;
}

function port(request: ScopeRequest, state: RuntimeState | undefined): number {
  const candidate =
    request.port ??
    numeric(setting("NYLORUN_PORT")) ??
    numeric(setting("PORT")) ??
    state?.port ??
    8787;
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535)
    throw new Error("The Runtime port must be an integer between 1 and 65535.");
  return candidate;
}

const numeric = (value: string | undefined): number | undefined => {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : Number.NaN;
};

export function resolveScope(request: ScopeRequest = {}): Scope {
  const projectRoot = request.global ? undefined : findProjectRoot(request.cwd);
  const kind: ScopeKind = projectRoot ? "project" : "global";
  const root = projectRoot ?? globalDataDir();
  const dataDir = projectRoot ? join(projectRoot, ".nylorun") : globalDataDir();
  const statePath = join(dataDir, "runtime.json");
  const state = readStateSync(statePath);
  const resolvedPort = port(request, state);
  const host = setting("HOST") ?? "127.0.0.1";
  return {
    kind,
    root,
    dataDir,
    sqlitePath:
      request.db ?? setting("NYLORUN_SQLITE_PATH") ?? join(dataDir, "runtime.sqlite"),
    credentialsPath: join(dataDir, "local-credentials.json"),
    statePath,
    logPath: join(dataDir, "runtime.log"),
    pidPath: join(dataDir, "runtime.pid"),
    host,
    port: resolvedPort,
    url: `http://${host}:${resolvedPort}`,
    label: projectRoot ? `project ${projectRoot}` : `global ${dataDir}`,
  };
}

export async function ensureDataDir(scope: Scope): Promise<void> {
  await mkdir(scope.dataDir, { recursive: true, mode: 0o700 });
  if (scope.kind !== "project") return;
  // A project that already keeps a .gitignore should not start committing local credentials;
  // creating one where the author chose not to have it would be a surprise, so we never do.
  const path = join(scope.root, ".gitignore");
  let current: string;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (/^\.nylorun\/?$/m.test(current)) return;
  await writeFile(
    path,
    `${current}${current.endsWith("\n") || !current ? "" : "\n"}.nylorun/\n`
  );
}

function readStateSync(path: string): RuntimeState | undefined {
  try {
    // Only the port is read during scope resolution, so a torn or hand-edited file is ignored.
    const value = JSON.parse(readFileSync(path, "utf8")) as RuntimeState;
    return typeof value?.port === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function readState(scope: Scope): Promise<RuntimeState | undefined> {
  try {
    const value = JSON.parse(await readFile(scope.statePath, "utf8"));
    return typeof value?.pid === "number" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function writeState(
  scope: Scope,
  state: RuntimeState
): Promise<void> {
  const temporary = `${scope.statePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, scope.statePath);
  await writeFile(scope.pidPath, `${state.pid}\n`, { mode: 0o600 });
}

export async function clearState(scope: Scope): Promise<void> {
  for (const path of [scope.statePath, scope.pidPath])
    await unlink(path).catch(() => {});
}

/**
 * The health fields this CLI relies on. Declared here rather than imported, because the CLI
 * may only depend on the agents SDK and the Runtime; version and scopeId are optional so a
 * Runtime that predates them still parses into a usable probe.
 */
export interface HealthResponse {
  status: string;
  service: string;
  version?: string;
  scopeId?: string;
  pid?: number;
}

const asHealth = (value: unknown): HealthResponse | undefined => {
  const body = value as Partial<HealthResponse> | null;
  if (!body || body.status !== "ok" || typeof body.service !== "string")
    return undefined;
  return {
    status: body.status,
    service: body.service,
    ...(typeof body.version === "string" ? { version: body.version } : {}),
    ...(typeof body.scopeId === "string" ? { scopeId: body.scopeId } : {}),
    ...(typeof body.pid === "number" ? { pid: body.pid } : {}),
  };
};

export interface HealthProbe {
  reachable: boolean;
  health?: HealthResponse;
  /** True when something answered the port but it is not a Runtime we can parse. */
  foreign?: boolean;
}

export async function probeHealth(
  url: string,
  timeoutMs = 2000
): Promise<HealthProbe> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${url}/health`, { signal });
  } catch {
    return { reachable: false };
  }
  if (!response.ok) return { reachable: true, foreign: true };
  try {
    const health = asHealth(await response.json());
    if (health?.service !== "oss-runtime")
      return { reachable: true, foreign: true };
    return { reachable: true, health };
  } catch {
    return { reachable: true, foreign: true };
  }
}

export const scopeId = (sqlitePath: string): string | undefined => {
  try {
    return createHash("sha256")
      .update(realpathSync(sqlitePath))
      .digest("hex")
      .slice(0, 16);
  } catch {
    return undefined;
  }
};

export function loadScopeEnvironment(scope: Scope): void {
  if (scope.kind === "project") loadProjectEnvironment(scope.root);
}
