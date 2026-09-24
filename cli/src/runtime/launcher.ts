/**
 * // CLIENTS-CCR: owned by WS-F1 — stub matching F1's published signature
 * (`export async function launcher(home, options?): Promise<LauncherHandle>`).
 * Replace when F1 merges.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CliError } from "../errors.js";
import { runtimeVersion } from "./version.js";

export type LauncherJsonEvent =
  | {
      type: "progress";
      phase: string;
      received?: number;
      total?: number;
      message?: string;
    }
  | { type: "result"; [field: string]: unknown }
  | {
      type: "error";
      code: string;
      message: string;
      remedy: string;
      details?: unknown;
    }
  | {
      type: "log";
      source: "host" | "tenant";
      tenantId?: string;
      line: string;
    };

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
  stdout: string;
  stderr: string;
}

export interface LauncherHandle {
  readonly home: string;
  readonly build: { path: string; version: string; launcher: string };
  invoke(
    args: readonly string[],
    options?: InvokeOptions,
  ): Promise<LauncherInvokeResult>;
  invokeStreaming(
    args: readonly string[],
    options?: InvokeOptions,
  ): Promise<LauncherInvokeResult>;
}

export interface InvokeOptions {
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: LauncherJsonEvent) => void;
  renderProgress?: boolean;
  signal?: AbortSignal;
}

export interface LauncherOptions {
  version?: string;
  registry?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  onProgress?: (event: {
    type: "progress";
    phase: string;
    received?: number;
    total?: number;
    message?: string;
  }) => void;
}

export function resolveHome(home?: string): string {
  if (home !== undefined && home.trim() !== "") return resolve(home);
  const fromEnv = process.env.NYLORUN_HOME?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(homedir(), ".nylorun"));
}

/**
 * Resolve the newest installed build or bootstrap, then return a handle.
 * Stub throws until F1 merges the real implementation.
 */
export async function launcher(
  home: string,
  _options: LauncherOptions = {},
): Promise<LauncherHandle> {
  const resolvedHome = resolveHome(home);
  void runtimeVersion;
  throw new CliError(
    // CLIENTS-CCR: awaiting WS-F1 launcher(home)
    `Runtime launcher is not available yet under ${resolvedHome}. ` +
      "WS-F1 must publish cli/src/runtime/launcher.ts.",
    1,
  );
}

export function throwOnLauncherFailure(outcome: LauncherInvokeResult): void {
  if (outcome.exitCode === 0) return;
  throw new CliError(
    outcome.error
      ? `${outcome.error.message}${outcome.error.remedy ? `\n${outcome.error.remedy}` : ""}`
      : outcome.stderr.trim() ||
          `Runtime launcher failed (exit ${outcome.exitCode}).`,
    outcome.exitCode === 2 ? 2 : 1,
  );
}
