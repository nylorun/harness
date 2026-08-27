import { createHash } from "node:crypto";
import { diagnostic } from "../diagnostics.js";
import { stableJson } from "../manifest.js";
import type { CapabilityManifest, FolderDiagnostic } from "../types.js";

export type PublishCheck = Readonly<{
  ok: boolean;
  diagnostics: readonly FolderDiagnostic[];
  /** Named rather than skipped: a check only the platform can run is still a check that is owed. */
  unchecked: readonly string[];
}>;

/**
 * The half of the publish check a client can perform, and only that half.
 *
 * What runs here: the manifest's own `digest` covers its content, and its `bundleDigest` covers the
 * bundle uploaded beside it. A manifest that does not describe the bytes it arrived with is refused
 * before anything is sent, so a refused publish changes nothing anywhere.
 *
 * What cannot run here, and is reported by name instead: whether the model identity is in the
 * platform's catalog, and whether every declared tool, skill, MCP server and secret is servable.
 * Those are facts only the platform holds. An unchecked thing announced is a different object from
 * an unchecked thing omitted.
 */
export function checkPublish(manifest: CapabilityManifest, bundle: Uint8Array): PublishCheck {
  const diagnostics: FolderDiagnostic[] = [];

  const bundleDigest = createHash("sha256").update(bundle).digest("hex");
  if (manifest.bundleDigest !== bundleDigest) {
    diagnostics.push(
      diagnostic(
        "NYLO_PUBLISH_BUNDLE_DIGEST_MISMATCH",
        "hosted-readiness",
        "error",
        "dist/nylo.manifest.json",
        "The manifest does not describe the bundle beside it.",
        "Rebuild the project so the manifest and dist/agent.mjs are produced together."
      )
    );
  }

  const { digest, ...rest } = manifest;
  const manifestDigest = createHash("sha256").update(stableJson(rest)).digest("hex");
  if (digest !== manifestDigest) {
    diagnostics.push(
      diagnostic(
        "NYLO_PUBLISH_MANIFEST_DIGEST_MISMATCH",
        "hosted-readiness",
        "error",
        "dist/nylo.manifest.json",
        "The manifest's digest does not cover its own content.",
        "Rebuild the project; do not edit dist/nylo.manifest.json by hand."
      )
    );
  }

  if (manifest.formatVersion !== 3) {
    diagnostics.push(
      diagnostic(
        "NYLO_PUBLISH_FORMAT_UNSUPPORTED",
        "hosted-readiness",
        "error",
        "dist/nylo.manifest.json",
        `This toolchain writes formatVersion 3 artifacts and found formatVersion ${String(manifest.formatVersion)}.`,
        "Use a toolchain version that matches the manifest you are publishing."
      )
    );
  }

  const unchecked = [
    `model identity ${manifest.agent.model} is in the platform catalog`,
    `${manifest.tools.length} tool(s), ${manifest.skills.length} skill(s) and ${manifest.mcp.length} MCP server(s) are servable`,
    `${manifest.agent.secrets.length} declared secret name(s) are provisioned`
  ];

  return Object.freeze({
    ok: diagnostics.every((item) => item.severity !== "error"),
    diagnostics: Object.freeze(diagnostics),
    unchecked: Object.freeze(unchecked)
  });
}
