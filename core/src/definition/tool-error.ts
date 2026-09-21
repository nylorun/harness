const errorBrand = Symbol.for("@nylorun/core/ToolError");
/**
 * Thrown from a tool `run` / `execute` to produce a failed tool result.
 * Prefer this over returning `{ kind: "failed" }` in new code.
 */
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    Object.defineProperty(this, errorBrand, { value: true });
    this.code = code;
  }
}

export function isToolError(error: unknown): error is ToolError {
  return (
    error instanceof ToolError ||
    (typeof error === "object" &&
      error !== null &&
      (error as Record<symbol, unknown>)[errorBrand] === true)
  );
}
