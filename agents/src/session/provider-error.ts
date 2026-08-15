import type { ProviderErrorCode } from "./types.js";

export type ProviderErrorOptions = Readonly<{
  code: ProviderErrorCode;
  retryable?: boolean;
  status?: number;
  cause?: unknown;
}>;

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "ProviderError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}
