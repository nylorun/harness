import type { BuildDiagnostic } from "../../types/shared.js";

/** Thrown when a workflow primitive fails its build-time checks. */
export class WorkflowBuildError extends Error {
  constructor(readonly diagnostics: readonly BuildDiagnostic[]) {
    super(
      diagnostics.map((item) => item.message).join("; ") || "Workflow build failed",
    );
    this.name = "WorkflowBuildError";
  }
}

export function diagnostic(
  code: string,
  message: string,
  extra: Partial<BuildDiagnostic> = {},
): BuildDiagnostic {
  return Object.freeze({ code, message, ...extra });
}

export function fail(diagnostics: readonly BuildDiagnostic[]): never {
  throw new WorkflowBuildError(Object.freeze([...diagnostics]));
}

export function failOne(code: string, message: string, extra?: Partial<BuildDiagnostic>): never {
  fail([diagnostic(code, message, extra)]);
}

/** Path parts: non-empty, with no `/`, `[` or `]`. */
export function isValidPathPart(part: string): boolean {
  return part.length > 0 && !/[\/\[\]]/.test(part);
}

export function assertValidPathPart(part: string, label: string): void {
  if (!isValidPathPart(part))
    failOne(
      "workflow.invalid-path-part",
      `${label} '${part}' must be a non-empty path part with no '/', '[' or ']'`,
    );
}

/** Record duplicate sibling path parts; returns diagnostics (does not throw). */
export function siblingUniquenessDiagnostics(
  parts: readonly string[],
  label: string,
): BuildDiagnostic[] {
  const seen = new Map<string, number>();
  const found: BuildDiagnostic[] = [];
  for (const part of parts) {
    const count = (seen.get(part) ?? 0) + 1;
    seen.set(part, count);
    if (count === 2)
      found.push(
        diagnostic(
          "workflow.duplicate-sibling",
          `Duplicate ${label} id '${part}'; path parts must be unique among siblings`,
          { details: { id: part } },
        ),
      );
  }
  return found;
}
