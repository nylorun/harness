import { createHash } from "node:crypto";
import { canonical } from "./canonical.js";
import type { AgentManifest } from "../types/manifest.js";

/** Canonical SHA-256 hex digest of a manifest (agent identity). */
export function hashManifest(manifest: AgentManifest): string {
  return createHash("sha256").update(canonical(manifest)).digest("hex");
}
