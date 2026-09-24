import type { ErrorCode } from "@nylorun/agents";

/**
 * Map launcher error codes (and a few Host states) to Tenants-era CLI exit codes.
 * See cli/README.md exit code table.
 */
export const LAUNCHER_ERROR_EXIT_CODES: Record<string, number> = {
  foreign_port: 4,
  host_start_failed: 7,
  incompatible_host: 5,
  protocol_unsupported: 5,
  // Everything else falls through to 1.
  version_required: 1,
  platform_unsupported: 1,
  install_failed: 1,
  integrity_mismatch: 1,
  lock_timeout: 1,
  host_unresponsive: 1,
  host_schema_newer: 1,
  host_format_newer: 1,
  downgrade_refused: 1,
  upgrade_failed: 1,
  active_work: 1,
  not_found: 1,
  connection_missing: 1,
  host_rejected: 1,
  origin_rejected: 1,
  unsupported_media_type: 1,
  tenant_conflict: 1,
};

export function exitCodeForLauncherError(
  code: ErrorCode | string | undefined,
): number {
  if (!code) return 1;
  return LAUNCHER_ERROR_EXIT_CODES[code] ?? 1;
}

/** `runtime status` when the Host is not running. */
export function exitCodeForStatusState(
  state: string | undefined,
): number | undefined {
  if (state === "running") return undefined;
  if (state === "foreign-port") return 4;
  if (state === "stopped" || state === "absent") return 3;
  if (state === "unresponsive") return 1;
  return 3;
}
