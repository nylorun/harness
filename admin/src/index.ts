import type {
  AdminStatus,
  AdminTenant,
  AdminTenantStatus,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import {
  ERROR_CODES,
  PROTOCOL_FEATURES,
  compareVersions,
  type ErrorCode,
} from "@nylorun/core/compatibility";

export { ERROR_CODES, PROTOCOL_FEATURES, compareVersions };
export type { ErrorCode };

export class AdminError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly details?: unknown;
  constructor(
    code: ErrorCode,
    message: string,
    options?: { status?: number; details?: unknown },
  ) {
    super(message);
    this.name = "AdminError";
    this.code = code;
    this.status = options?.status;
    this.details = options?.details;
  }
}

export interface Admin {
  readonly url: string;
  readonly source: "options" | "environment" | "local-host";
  status(): Promise<AdminStatus>;
  listTenants(): Promise<AdminTenant[]>;
  getTenant(id: string): Promise<AdminTenantStatus>;
  deleteTenant(
    id: string,
    options?: { activeWork?: "refuse" | "drain" | "cancel" },
  ): Promise<void>;
  createTenant(options: {
    name: string;
  }): Promise<{ tenant: TenantEnvelope; applicationKey: string }>;
}

/** Wave 0 stub; WS-B implements D§6. */
export function createAdmin(options?: {
  url?: string;
  key?: string;
  home?: string;
}): Admin {
  void options;
  throw new Error("not implemented");
}

export type { AdminStatus, AdminTenant, AdminTenantStatus, TenantEnvelope };
