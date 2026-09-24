/**
 * // CLIENTS-CCR: owned by WS-F1 — stub matching the planned F1 signature.
 * F2 calls `launcher(home)` / `runtimeVersion()`; replace this file when F1 merges.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorCode } from "@nylorun/agents";
import { CliError } from "../errors.js";

export type LauncherProgressPhase =
  | "download"
  | "verify"
  | "extract"
  | "install"
  | "start"
  | "stop"
  | "wait";

export type LauncherEvent =
  | {
      type: "progress";
      phase: LauncherProgressPhase;
      received?: number;
      total?: number;
      message?: string;
    }
  | { type: "result"; [field: string]: unknown }
  | {
      type: "error";
      code: ErrorCode;
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

export interface UpResult {
  url: string;
  hostId: string;
  pid: number;
  version: string;
  started: boolean;
}

export interface LauncherRunResult {
  events: LauncherEvent[];
  result?: Record<string, unknown>;
  exitCode: number;
}

export interface LauncherHandle {
  /** Run launcher argv (without the binary name) with `--json`. */
  run(args: readonly string[]): Promise<LauncherRunResult>;
  up(options?: { version?: string; port?: number }): Promise<UpResult>;
}

export function resolveHome(home?: string): string {
  if (home !== undefined && home.trim() !== "") return resolve(home);
  const fromEnv = process.env.NYLORUN_HOME?.trim();
  if (fromEnv) return resolve(fromEnv);
  return resolve(join(homedir(), ".nylorun"));
}

/** Reads `cli/package.json` `nylorun.runtime` (D7). F1 owns the field. */
export function runtimeVersion(): string {
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "../../package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    nylorun?: { runtime?: string };
    dependencies?: { "@nylorun/runtime"?: string };
    version?: string;
  };
  const pinned = pkg.nylorun?.runtime?.trim();
  if (pinned) return pinned;
  // CLIENTS-CCR: F1 adds nylorun.runtime; fall back until then.
  return pkg.dependencies?.["@nylorun/runtime"] ?? pkg.version ?? "0.0.0";
}

/**
 * Resolve the newest installed build's launcher and run commands.
 * Stub throws until F1 implements bootstrap + spawn.
 */
export function launcher(home: string): LauncherHandle {
  const root = resolveHome(home);
  return {
    async run(_args: readonly string[]): Promise<LauncherRunResult> {
      throw new CliError(
        // CLIENTS-CCR: awaiting WS-F1 launcher(home).run
        `Runtime launcher is not available yet under ${root}. ` +
          "WS-F1 must publish cli/src/runtime/launcher.ts.",
        1,
      );
    },
    async up(options = {}): Promise<UpResult> {
      const args = ["up"];
      if (options.version) args.push("--version", options.version);
      if (options.port !== undefined) args.push("--port", String(options.port));
      const { result, exitCode } = await this.run(args);
      if (exitCode !== 0 || !result) {
        throw new CliError(
          `Runtime up failed under ${root} (exit ${exitCode}).`,
          exitCode || 1,
        );
      }
      return {
        url: String(result.url),
        hostId: String(result.hostId),
        pid: Number(result.pid),
        version: String(result.version),
        started: Boolean(result.started),
      };
    },
  };
}
