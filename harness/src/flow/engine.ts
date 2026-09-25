import { HarnessError } from "@nylorun/core/define";
import { WorkflowManifestSchema, type WorkflowManifest } from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/define";
import type { DurableHost } from "../run/durable.js";
import { HostSuspension } from "../loop/host-suspension.js";
import { CHECKPOINT_VERSION, FLOW_ENGINE_VERSION } from "../compatibility.js";
import type { FlowCheckpoint } from "./checkpoint.js";
import { createFlowContext, failureOf, settleInFlight } from "./context.js";
import { runNode, unwrapSlot } from "./node.js";
import { runLoop } from "./loop.js";
import { FlowNodeError, type FlowDurableResult } from "./types.js";

/**
 * Deterministic flow interpreter for workflow manifests.
 * One module per primitive; returns effects only (SD-I1).
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

  // Root Loop keeps the dedicated entry (history / verify wiring).
  if ("loop" in root) return runLoop({ manifest, checkpoint, host, signal });

  const ctx = createFlowContext({ manifest, checkpoint, host, signal });
  const { part } = unwrapSlot(root);
  const rootPath = part;

  try {
    if (signal?.aborted)
      return { status: "cancelled", checkpoint, result: { status: "cancelled" } };
    const output = await runNode(ctx, root, rootPath, checkpoint.input);
    return {
      status: "completed",
      checkpoint,
      result: { status: "completed", output },
    };
  } catch (error) {
    await settleInFlight(ctx);
    if (error instanceof HostSuspension) {
      return {
        status: [...ctx.pending.values()].includes("uncertain") ? "uncertain" : "waiting",
        checkpoint,
        effectIds: [...ctx.pending.keys()],
      };
    }
    if (error instanceof FlowNodeError && error.failure.code === "cancelled")
      return { status: "cancelled", checkpoint, result: { status: "cancelled" } };
    const failure = failureOf(error, rootPath);
    return {
      status: "failed",
      checkpoint,
      result: { status: "failed", error: failure },
    };
  }
}
