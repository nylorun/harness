import { HarnessError } from "@nylorun/core/define";
import { WorkflowManifestSchema, type WorkflowManifest } from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/define";
import type { DurableHost } from "../run/durable.js";
import { CHECKPOINT_VERSION, FLOW_ENGINE_VERSION } from "../compatibility.js";
import type { FlowCheckpoint } from "./checkpoint.js";
import { runLoop, type FlowDurableResult } from "./loop.js";

/**
 * Deterministic flow interpreter for workflow manifests.
 * Tracer: root Loop only; other primitives arrive in later lanes.
 */
export async function runFlowDurable(options: {
  manifest: WorkflowManifest;
  checkpoint: FlowCheckpoint;
  host: DurableHost;
  signal?: AbortSignal;
}): Promise<FlowDurableResult> {
  const { manifest, checkpoint, host, signal } = options;
  WorkflowManifestSchema.parse(manifest);
  if (
    checkpoint.version !== CHECKPOINT_VERSION ||
    checkpoint.engineVersion !== FLOW_ENGINE_VERSION ||
    checkpoint.manifestHash !== hashManifest(manifest)
  )
    throw new HarnessError("execution.incompatible", "Incompatible flow checkpoint");

  const root = manifest.root;
  if ("loop" in root) return runLoop({ manifest, checkpoint, host, signal });

  throw new HarnessError(
    "execution.invalid-state",
    `Unsupported workflow root kind (tracer supports Loop only)`,
  );
}
