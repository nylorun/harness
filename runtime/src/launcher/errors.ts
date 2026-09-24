import type { ErrorCode } from "@nylorun/core/compatibility";

/** Operational launcher failure (exit 1). Usage errors are separate (exit 2). */
export class LauncherError extends Error {
  readonly code: ErrorCode;
  readonly remedy: string;
  readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    remedy: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "LauncherError";
    this.code = code;
    this.remedy = remedy;
    if (details !== undefined) this.details = details;
  }
}

export class UsageError extends Error {
  readonly remedy: string;

  constructor(message: string, remedy = "See nylorun-runtime --help.") {
    super(message);
    this.name = "UsageError";
    this.remedy = remedy;
  }
}
