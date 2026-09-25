import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { PROTOCOL_VERSION } from "@nylorun/agents";
import { CliError } from "../errors.js";
import {
  exitCodeForLauncherError,
} from "./exit-codes.js";
import { renderProgress, type ProgressEvent } from "./progress.js";
import { runtimeVersion } from "./version.js";

/** The launcher command `@nylorun/runtime` installs (npm bin). */
export const LAUNCHER_BIN = "nylorun-runtime";

/** The `nylorun-runtime --json` contract this CLI speaks (core LAUNCHER_PROTOCOL). */
const LAUNCHER_PROTOCOL = 1;

/** Resolve NYLORUN_HOME, an explicit home, or `~/.nylorun`. */
export function resolveHome(home?: string): string {
  if (home !== undefined && home.trim() !== "") return resolve(home);
  const fromEnv = process.env.NYLORUN_HOME?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(homedir(), ".nylorun"));
}

export type LauncherJsonEvent =
  | ProgressEvent
  | { type: "result"; [field: string]: unknown }
  | {
      type: "error";
      code: string;
      message: string;
      remedy: string;
      details?: unknown;
    }
  | { type: "log"; source: "host" | "tenant"; tenantId?: string; line: string };

export interface LauncherInvokeResult {
  events: LauncherJsonEvent[];
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    remedy: string;
    details?: unknown;
  };
  exitCode: number;
  /** Raw stdout (NDJSON). */
  stdout: string;
  stderr: string;
}

/** The installed Runtime a handle runs, as its `version` command reports it. */
export interface InstalledRuntime {
  /** `nylorun-runtime` found on PATH. */
  readonly bin: string;
  readonly version: string;
  /** Node the Runtime reported (the Host runs on the same Node). */
  readonly node: string;
}

export interface LauncherHandle {
  readonly home: string;
  readonly runtime: InstalledRuntime;
  /**
   * Run a launcher command with `--json --home`. Progress events are rendered
   * to stderr by default. Returns parsed events and the process exit code.
   */
  invoke(
    args: readonly string[],
    options?: InvokeOptions,
  ): Promise<LauncherInvokeResult>;
  /**
   * Long-running invoke (e.g. `run`, `logs --follow`). Resolves when the
   * child exits; streams progress/log events as they arrive.
   */
  invokeStreaming(
    args: readonly string[],
    options?: InvokeOptions,
  ): Promise<LauncherInvokeResult>;
}

export interface InvokeOptions {
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: LauncherJsonEvent) => void;
  /** When false, skip default progress rendering. Default true. */
  renderProgress?: boolean;
  signal?: AbortSignal;
}

export interface LauncherOptions {
  /** Environment for the launcher, including the PATH it is found on. */
  env?: NodeJS.ProcessEnv;
}

/** Install command shown whenever the Runtime is missing or incompatible. */
export function runtimeInstallCommand(): string {
  return `npm install --global @nylorun/runtime@${runtimeVersion()}`;
}

/** Find `name` on PATH (with PATHEXT on Windows). */
export function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = join(dir, `${name}${extension.toLowerCase()}`);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        /* not here */
      }
    }
  }
  return undefined;
}

/**
 * npm links a bin to the package's JS file: a symlink on POSIX, a `.cmd` shim
 * next to the package on Windows. Running that file on this Node avoids
 * spawning `.cmd` shims, which Node refuses without a shell.
 */
function launcherScript(bin: string): string | undefined {
  if (process.platform !== "win32") {
    const real = realpathSync(bin);
    return real.endsWith(".js") ? real : undefined;
  }
  const dir = dirname(bin);
  const main = join("@nylorun", "runtime", "dist", "launcher", "main.js");
  // Global prefix (`<prefix>/nylorun-runtime.cmd`) or project `.bin`.
  for (const candidate of [
    join(dir, "node_modules", main),
    join(dir, "..", main),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Find the installed Runtime's launcher on PATH and check it speaks this CLI's
 * launcher and Host protocols. Never downloads or installs anything: a missing
 * Runtime is a prerequisite error that names the install command.
 */
export async function launcher(
  home: string,
  options: LauncherOptions = {},
): Promise<LauncherHandle> {
  const resolvedHome = resolve(home);
  const env = options.env ?? process.env;
  const bin = findOnPath(LAUNCHER_BIN, env);
  if (!bin) {
    throw new CliError(
      `The Nylorun Runtime is not installed (no "${LAUNCHER_BIN}" on PATH).\nInstall it, then retry:\n  ${runtimeInstallCommand()}`,
      1,
    );
  }
  const probe = await invokeLauncher(
    bin,
    resolvedHome,
    ["version"],
    { env, renderProgress: false },
    false,
  );
  throwOnLauncherFailure(probe);
  const info = probe.result ?? {};
  const version =
    typeof info.runtimeVersion === "string" ? info.runtimeVersion : "unknown";
  const protocol = info.protocol as { min?: unknown; max?: unknown } | undefined;
  const hostCompatible =
    typeof protocol?.min === "number" &&
    typeof protocol.max === "number" &&
    protocol.min <= PROTOCOL_VERSION &&
    PROTOCOL_VERSION <= protocol.max;
  if (info.launcherProtocol !== LAUNCHER_PROTOCOL || !hostCompatible) {
    throw new CliError(
      `The installed Nylorun Runtime ${version} (${bin}) is not compatible with this CLI.\nInstall a compatible Runtime, then retry:\n  ${runtimeInstallCommand()}`,
      1,
    );
  }
  return createHandle(
    resolvedHome,
    {
      bin,
      version,
      node: typeof info.node === "string" ? info.node : "unknown",
    },
    env,
  );
}

function createHandle(
  home: string,
  runtime: InstalledRuntime,
  defaultEnv: NodeJS.ProcessEnv,
): LauncherHandle {
  const run = (
    args: readonly string[],
    options: InvokeOptions = {},
    streaming: boolean,
  ): Promise<LauncherInvokeResult> =>
    invokeLauncher(runtime.bin, home, args, {
      ...options,
      env: options.env ?? defaultEnv,
    }, streaming);

  return {
    home,
    runtime,
    invoke: (args, options) => run(args, options, false),
    invokeStreaming: (args, options) => run(args, options, true),
  };
}

/** Quote one argument for cmd.exe (only used for non-npm `.cmd` shims). */
function quoteForCmd(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function spawnLauncher(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv | undefined,
): ChildProcess {
  const options = {
    env: { ...env },
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
  };
  const script = launcherScript(bin);
  if (script) return spawn(process.execPath, [script, ...args], options);
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(bin)) {
    // Windows runs .cmd files only through cmd.exe, which needs quoting.
    return spawn(quoteForCmd(bin), args.map(quoteForCmd), {
      ...options,
      shell: true,
    });
  }
  return spawn(bin, args, options);
}

async function invokeLauncher(
  bin: string,
  home: string,
  args: readonly string[],
  options: InvokeOptions,
  _streaming: boolean,
): Promise<LauncherInvokeResult> {
  const childArgs = ["--json", "--home", home, ...args];
  const child = spawnLauncher(bin, childArgs, options.env);

  const events: LauncherJsonEvent[] = [];
  let result: Record<string, unknown> | undefined;
  let error: LauncherInvokeResult["error"];
  let stdout = "";
  let stderr = "";
  let lineBuffer = "";

  const handleLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event: LauncherJsonEvent;
    try {
      event = JSON.parse(trimmed) as LauncherJsonEvent;
    } catch {
      return;
    }
    events.push(event);
    options.onEvent?.(event);
    if (event.type === "progress" && options.renderProgress !== false) {
      renderProgress(event);
    }
    if (event.type === "result") {
      const { type: _t, ...fields } = event;
      result = fields;
    }
    if (event.type === "error") {
      error = {
        code: event.code,
        message: event.message,
        remedy: event.remedy,
        ...(event.details !== undefined ? { details: event.details } : {}),
      };
    }
    if (event.type === "log") {
      const prefix =
        event.source === "tenant" && event.tenantId
          ? `[${event.tenantId}] `
          : "";
      process.stdout.write(`${prefix}${event.line}\n`);
    }
  };

  child.stdout?.on("data", (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    stdout += text;
    lineBuffer += text;
    const parts = lineBuffer.split("\n");
    lineBuffer = parts.pop() ?? "";
    for (const part of parts) handleLine(part);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });

  const abort = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  };
  if (options.signal) {
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }

  const exitCode = await waitForExit(child);
  if (lineBuffer.trim()) handleLine(lineBuffer);

  if (options.signal) {
    options.signal.removeEventListener("abort", abort);
  }

  return {
    events,
    ...(result ? { result } : {}),
    ...(error ? { error } : {}),
    exitCode,
    stdout,
    stderr,
  };
}

function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code !== null) resolvePromise(code);
      else resolvePromise(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
    });
  });
}

/**
 * Throw CliError with the Tenants-era exit code for a failed launcher invoke.
 */
export function throwOnLauncherFailure(outcome: LauncherInvokeResult): void {
  if (outcome.exitCode === 0) return;
  if (outcome.exitCode === 2) {
    throw new CliError(
      outcome.error?.message ??
        (outcome.stderr.trim() || "Invalid runtime arguments."),
      2,
    );
  }
  const code = outcome.error?.code;
  const message = outcome.error
    ? `${outcome.error.message}${outcome.error.remedy ? `\n${outcome.error.remedy}` : ""}`
    : outcome.stderr.trim() || `Runtime launcher failed (exit ${outcome.exitCode}).`;
  throw new CliError(message, exitCodeForLauncherError(code));
}
