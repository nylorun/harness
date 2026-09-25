import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonical } from "./canonical.js";
import type { AgentManifest } from "../types/manifest.js";
import type { WorkflowManifest } from "../types/workflow.js";

/** Canonical SHA-256 hex digest of an agent or workflow definition document. */
export function hashManifest(manifest: AgentManifest | WorkflowManifest): string {
  return bytesToHex(sha256(utf8ToBytes(canonical(manifest))));
}
