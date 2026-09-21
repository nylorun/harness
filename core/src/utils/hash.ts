import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { canonical } from "./canonical.js";
import type { AgentManifest } from "../types/manifest.js";

/** Canonical SHA-256 hex digest of a manifest (agent identity). */
export function hashManifest(manifest: AgentManifest): string {
  return bytesToHex(sha256(canonical(manifest)));
}
