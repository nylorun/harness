import type { Quarantine } from "./types.js";

/** Typed quarantine failure thrown by stores and migration. */
export class QuarantineError extends Error implements Quarantine {
  readonly code: Quarantine["code"];
  readonly repair: string;
  readonly lockPath?: string;
  readonly lockPid?: number;

  constructor(fields: Quarantine) {
    super(fields.message);
    this.name = "QuarantineError";
    this.code = fields.code;
    this.repair = fields.repair;
    if (fields.lockPath !== undefined) this.lockPath = fields.lockPath;
    if (fields.lockPid !== undefined) this.lockPid = fields.lockPid;
  }

  toQuarantine(): Quarantine {
    return {
      code: this.code,
      message: this.message,
      repair: this.repair,
      ...(this.lockPath !== undefined ? { lockPath: this.lockPath } : {}),
      ...(this.lockPid !== undefined ? { lockPid: this.lockPid } : {}),
    };
  }
}

export function isQuarantineError(error: unknown): error is QuarantineError {
  return error instanceof QuarantineError;
}

export function asQuarantine(error: unknown): Quarantine | undefined {
  if (isQuarantineError(error)) return error.toQuarantine();
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    "message" in error &&
    "repair" in error
  ) {
    return error as Quarantine;
  }
  return undefined;
}

/** CLI-facing repair strings for every quarantine code (B9). */
export function repairFor(
  code: Quarantine["code"],
  detail: {
    tenantId?: string;
    lockPath?: string;
    lockPid?: number;
    migrationPath?: string;
  } = {},
): string {
  const id = detail.tenantId ? ` ${detail.tenantId}` : "";
  switch (code) {
    case "locked":
      return (
        `nylorun tenant status${id}` +
        (detail.lockPath !== undefined && detail.lockPid !== undefined
          ? ` — stop pid ${detail.lockPid} holding ${detail.lockPath}, or remove a stale lock`
          : " — resolve the .runtime-lock conflict")
      );
    case "kek-missing":
      return `nylorun tenant status${id} — restore vault-kek for this Tenant (ciphertext cannot be opened without it)`;
    case "corrupt":
      return `nylorun tenant status${id} — repair or restore the Tenant directory from backup`;
    case "schema-too-new":
      return `nylorun runtime restart` +
        `${id ? ` — Tenant${id} needs a newer Host` : " — Host schema is older than this Tenant"}`;
    case "migration-failed":
      return detail.migrationPath
        ? `restore ${detail.migrationPath} over the Tenant files, then nylorun tenant status${id}`
        : `nylorun tenant status${id} — restore from .migration/ snapshot, then retry`;
    case "envelope-invalid":
      return `nylorun tenant status${id} — fix or replace tenant.json so its id matches the directory name`;
    case "open-timeout":
      return `nylorun tenant status${id} — open timed out; inspect locks and SQLite, then retry`;
    case "open-failed":
      return `nylorun tenant status${id} — inspect Tenant logs and repair before the Host retries open`;
  }
}

export function quarantine(
  code: Quarantine["code"],
  message: string,
  detail: {
    tenantId?: string;
    lockPath?: string;
    lockPid?: number;
    migrationPath?: string;
  } = {},
): QuarantineError {
  return new QuarantineError({
    code,
    message,
    repair: repairFor(code, detail),
    ...(detail.lockPath !== undefined ? { lockPath: detail.lockPath } : {}),
    ...(detail.lockPid !== undefined ? { lockPid: detail.lockPid } : {}),
  });
}

/** Conflict when create bootstrap material does not match an existing Tenant (HTTP 409). */
export class TenantConflictError extends Error {
  readonly statusCode = 409 as const;
  constructor(message = "Tenant already exists with different bootstrap material") {
    super(message);
    this.name = "TenantConflictError";
  }
}

/** Delete refused because the Tenant still has live work (HTTP 409). */
export class TenantBusyError extends Error {
  readonly statusCode = 409 as const;
  constructor(message = "Tenant has live work; pass activeWork=drain|cancel or retry later") {
    super(message);
    this.name = "TenantBusyError";
  }
}
