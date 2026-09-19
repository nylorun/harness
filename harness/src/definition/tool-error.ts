/**
 * Thrown from a tool `run` / `execute` to produce a failed tool result.
 * Prefer this over returning `{ kind: "failed" }` in new code.
 */
export class ToolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError;
}
