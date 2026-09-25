import type { JsonValue } from "@nylorun/core/define";
import { WorkflowManifestSchema, type WorkflowManifest } from "@nylorun/core/contracts";
import { hashManifest } from "@nylorun/core/define";
import { CHECKPOINT_VERSION, FLOW_ENGINE_VERSION } from "../compatibility.js";

/** Private persistence contract for workflow sessions; not a session wire type. */
export interface FlowCheckpoint {
  readonly version: 1;
  readonly engineVersion: typeof FLOW_ENGINE_VERSION;
  readonly manifestHash: string;
  readonly sessionId: string;
  readonly turnId: string;
  /** Increment for each human/event continuation, not for an action result. */
  readonly segment: number;
  readonly input: JsonValue;
}

export function createFlowCheckpoint(input: {
  manifest: WorkflowManifest;
  sessionId: string;
  turnId: string;
  input: JsonValue;
  segment?: number;
}): FlowCheckpoint {
  WorkflowManifestSchema.parse(input.manifest);
  return {
    version: CHECKPOINT_VERSION,
    engineVersion: FLOW_ENGINE_VERSION,
    manifestHash: hashManifest(input.manifest),
    sessionId: input.sessionId,
    turnId: input.turnId,
    segment: input.segment ?? 0,
    input: input.input,
  };
}
