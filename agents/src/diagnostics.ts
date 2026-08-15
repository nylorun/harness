import type { DiagnosticPhase, FolderDiagnostic } from "./types.js";

export function diagnostic(
  code: string,
  phase: DiagnosticPhase,
  severity: "error" | "warning",
  file: string,
  message: string,
  hint: string
): FolderDiagnostic {
  return Object.freeze({ code, phase, severity, file, message, hint });
}

export class NyloBuildError extends Error {
  readonly diagnostic: FolderDiagnostic;

  constructor(diagnosticValue: FolderDiagnostic) {
    super(`${diagnosticValue.code}: ${diagnosticValue.message}`);
    this.name = "NyloBuildError";
    this.diagnostic = diagnosticValue;
  }
}
