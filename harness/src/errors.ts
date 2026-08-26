import type { BuildDiagnostic } from "./types/shared.js";

export class AgentBuildError extends Error {
  constructor(readonly diagnostics: readonly BuildDiagnostic[]) {
    super(diagnostics.map((item) => item.message).join("; ") || "Agent build failed");
    this.name = "AgentBuildError";
  }
}

export class AgentLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLifecycleError";
  }
}
