import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "../errors.js";
import { bootstrap } from "./bootstrap.js";
import { newestBuild, type InstalledBuild } from "./builds.js";
import {
  exitCodeForLauncherError,
} from "./exit-codes.js";
import { renderProgress, type ProgressEvent } from "./progress.js";
import { runtimeVersion } from "./version.js";

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

export interface LauncherHandle {
  readonly home: string;
  readonly build: InstalledBuild;
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
  /** Pin used when bootstrapping. Default: `runtimeVersion()`. */
  version?: string;
  registry?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  onProgress?: (event: ProgressEvent) => void;
  /** Skip bootstrap when no build exists (tests). */
  bootstrap?: typeof bootstrap;
}

/**
 * Resolve the newest installed build or bootstrap the CLI pin, then return a
 * handle that runs `nylorun-runtime` with `--json` (F1-3).
 */
export async function launcher(
  home: string,
  options: LauncherOptions = {},
): Promise<LauncherHandle> {
  const resolvedHome = resolve(home);
  const env = options.env ?? process.env;
  let build = newestBuild(resolvedHome);
  if (!build) {
    const version = options.version ?? runtimeVersion();
    const boot = options.bootstrap ?? bootstrap;
    await boot(resolvedHome, version, {
      ...(options.registry ? { registry: options.registry } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      env,
    });
    build = newestBuild(resolvedHome);
    if (!build) {
      throw new CliError(
        `Bootstrap finished but no Runtime build is installed under ${resolvedHome}.`,
        1,
      );
    }
  }
  return createHandle(resolvedHome, build, env);
}

function createHandle(
  home: string,
  build: InstalledBuild,
  defaultEnv: NodeJS.ProcessEnv,
): LauncherHandle {
  const run = (
    args: readonly string[],
    options: InvokeOptions = {},
    streaming: boolean,
  ): Promise<LauncherInvokeResult> =>
    invokeLauncher(build.launcher, home, args, {
      ...options,
      env: options.env ?? defaultEnv,
    }, streaming);

  return {
    home,
    build,
    invoke: (args, options) => run(args, options, false),
    invokeStreaming: (args, options) => run(args, options, true),
  };
}

async function invokeLauncher(
  bin: string,
  home: string,
  args: readonly string[],
  options: InvokeOptions,
  _streaming: boolean,
): Promise<LauncherInvokeResult> {
  const childArgs = ["--json", "--home", home, ...args];
  const child = spawn(bin, childArgs, {
    env: { ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

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
