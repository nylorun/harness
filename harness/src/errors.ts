import type { BuildDiagnostic } from "./types/shared.js";

export class AgentBuildError extends Error {
  constructor(readonly diagnostics: readonly BuildDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join("; ") || "Agent build failed");
    this.name = "AgentBuildError";
  }
}

export class HarnessLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessLifecycleError";
  }
}

export class HarnessInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessInvariantError";
  }
}
