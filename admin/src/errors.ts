import type { ErrorCode } from "@nylorun/core/compatibility";

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
