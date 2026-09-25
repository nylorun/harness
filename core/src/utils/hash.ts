import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { canonical } from "./canonical.js";
import type { AgentManifest } from "../types/manifest.js";
import type { WorkflowManifest } from "../types/workflow.js";

/** Canonical SHA-256 hex digest of an agent or workflow definition document. */
export function hashManifest(manifest: AgentManifest | WorkflowManifest): string {
  return bytesToHex(sha256(canonical(manifest)));
}
