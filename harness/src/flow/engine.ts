import { HarnessError } from "@nylorun/core/define";
import type { WorkflowManifest } from "@nylorun/core/contracts";
import type { DurableHost, DurableResult } from "../run/durable.js";
import type { FlowCheckpoint } from "./checkpoint.js";

/**
 * Deterministic flow interpreter for workflow manifests.
 * Wave 1 seam only — lane L2 / tracer bullet implement behaviour.
 */
export async function runFlowDurable(_options: {
  manifest: WorkflowManifest;
  checkpoint: FlowCheckpoint;
  host: DurableHost;
  signal?: AbortSignal;
}): Promise<DurableResult> {
  throw new HarnessError("execution.invalid-state", "runFlowDurable is not implemented");
}
