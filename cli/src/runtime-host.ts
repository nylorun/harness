/**
 * Bridge for WS-F consumers (`project-runner`, `dev`/`serve` via `cli.ts`).
 * New Host lifecycle lives in `./host/*`. Call sites still pass a project/global
 * `Scope`; the Host process is keyed by `NYLORUN_HOME` / `~/.nylorun` and the
 * scope's port is forwarded when starting. WS-F migrates call sites and deletes
 * this file.
 */
import type { Scope } from "./scope.js";
import { cliRuntimePackageVersion } from "./host/install.js";
import {
  assertHostCompatible,
  warnHostIncompatible,
} from "./host/compatibility.js";
import {
  down,
  ensureHost,
  hostStatus as hostStatusAtRoot,
  logsCommand,
  up,
  type HostStatus,
  type HostProcessState,
} from "./host/lifecycle.js";
import { resolveHostRoot } from "./host/root.js";

export type HostState = HostProcessState;
export type Status = HostStatus & { scope?: Scope };

export const cliRuntimeVersion = cliRuntimePackageVersion;

export async function hostStatus(scope?: Scope): Promise<Status> {
  const status = await hostStatusAtRoot(resolveHostRoot());
  return scope ? { ...status, scope } : status;
}

export async function startHost(
  scope: Scope,
  options: { foreground?: boolean; restart?: boolean } = {},
): Promise<Status> {
  if (options.restart) await stopHost(scope);
  const result = await up({
    port: scope.port,
    foreground: options.foreground,
  });
  return { ...result.status, scope };
}

export async function stopHost(
  _scope?: Scope,
  options: { timeoutMs?: number } = {},
): Promise<"stopped" | "not-running"> {
  return down({
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
}

export interface EnsureOptions {
  autostart: boolean;
  quiet?: boolean;
}

export async function ensureRuntime(
  scope: Scope,
  options: EnsureOptions,
): Promise<Status> {
  const status = await ensureHost({
    autostart: options.autostart,
    quiet: options.quiet,
  });
  return { ...status, scope };
}

export function assertCompatible(scope: Scope, status: Status): void {
  void scope;
  void assertHostCompatible(status.url).catch((error: unknown) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
  // Synchronous surface for existing callers: probe must already be running.
  // Prefer assertHostCompatible at await sites. This sync wrapper is best-effort.
}

export function warnIncompatible(scope: Scope, status: Status): void {
  void scope;
  void warnHostIncompatible(status.url);
}

export async function tailLog(
  scope: Scope,
  options: { follow: boolean; lines: number },
): Promise<void> {
  void scope;
  await logsCommand({ follow: options.follow, lines: options.lines });
}
