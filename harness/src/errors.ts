/** Machine-readable error raised by Harness-owned code. */
export type HarnessErrorCode =
  | "adapter.invalid-outcome"
  | "adapter.not-registered"
  | "agent.build-failed"
  | "agent.lifecycle-sealed"
  | "context.invalid-item"
  | "context.invalid-item-type"
  | "context.invalid-order"
  | "context.invalid-reason"
  | "context.invalid-slot"
  | "interaction.invalid"
  | "interaction.missing-resume"
  | "interaction.uncorrelated-resume"
  | "json.invalid-data"
  | "json.invalid-object"
  | "middleware.next-after-return"
  | "middleware.next-called-twice"
  | "middleware.request-mutators-revoked"
  | "model.candidate-missing"
  | "model.invalid-candidate"
  | "model.invalid-directive"
  | "configuration.duplicate-tool-name"
  | "configuration.invalid"
  | "configuration.invalid-instructions"
  | "configuration.invalid-order"
  | "configuration.invalid-reason"
  | "configuration.invalid-slot"
  | "configuration.invalid-tools"
  | "configuration.model-selection-conflict"
  | "response.invalid-replacement"
  | "session.stale-result"
  | "tool.invalid-arguments"
  | "tool.invalid-name"
  | "tool.invalid-schema"
  | "tool.invalid-tool-result";

export type HarnessErrorDetails = Readonly<Record<string, string | number | boolean>>;

export interface HarnessErrorOptions {
  readonly cause?: unknown;
  readonly details?: HarnessErrorDetails;
}

/**
 * The sole error shape produced by Harness itself. Message text is explanatory;
 * callers must branch on `code`.
 */
export class HarnessError extends Error {
  readonly code: HarnessErrorCode;
  readonly details: HarnessErrorDetails;

  constructor(code: HarnessErrorCode, message: string, options: HarnessErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HarnessError";
    this.code = code;
    this.details = Object.freeze({ ...(options.details ?? {}) });
  }
}

export function isHarnessError(error: unknown): error is HarnessError {
  return error instanceof HarnessError;
}
