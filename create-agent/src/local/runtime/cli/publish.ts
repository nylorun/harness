import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createAuthoringArchive, readArtifact } from "../publish/archive.js";
import { checkPublish } from "../publish/check.js";
import { renderDiagnostic, styleFor } from "../runtime/render.js";
import type { CapabilityManifest } from "../types.js";
import type { Args } from "./args.js";
import { envelope, readManifest } from "./index.js";

/** Where a publish goes. Absent, the command reports what it would send and stops. */
function serviceConfig(): Readonly<{ url?: string; token?: string }> {
  const url = process.env.NYLO_AGENT_SERVICE_URL?.trim();
  const token = process.env.NYLO_AGENT_SERVICE_TOKEN?.trim();
  return {
    ...(url === undefined || url === "" ? {} : { url }),
    ...(token === undefined || token === "" ? {} : { token })
  };
}

/**
 * Publishing is gather, check, upload — and **nothing here builds**. The build already happened, on
 * the builder's machine, before this command saw anything.
 */
export async function runPublish(args: Args): Promise<number> {
  const style = styleFor(process.stdout.isTTY === true && !args.json);
  const project = resolve(args.project);

  const bundle = await readArtifact(project, "agent.mjs");
  const manifest = await readManifest(project);
  if (bundle === undefined || manifest === undefined) {
    process.stderr.write(
      `${style.red("error")} dist/agent.mjs and dist/nylo.manifest.json must both exist.\n${style.dim("Run `nylo build` first — publish never builds.")}\n`
    );
    return 1;
  }

  const archive = await createAuthoringArchive(project);
  const check = checkPublish(manifest, bundle);

  const artifacts = {
    bundle: { bytes: bundle.byteLength, digest: createHash("sha256").update(bundle).digest("hex") },
    manifest: { bytes: Buffer.byteLength(JSON.stringify(manifest)), digest: manifest.digest },
    archive: { bytes: archive.data.byteLength, digest: archive.digest, entries: archive.entries.length }
  };

  if (!check.ok) {
    if (args.json) process.stdout.write(envelope("publish", false, { artifacts }, check.diagnostics));
    else for (const item of check.diagnostics) process.stderr.write(`${renderDiagnostic(item, style)}\n`);
    // A refused publish changes nothing: nothing has been sent at this point, by construction.
    return 1;
  }

  const service = serviceConfig();
  if (service.url === undefined) {
    const data = { artifacts, excluded: archive.excluded, unchecked: check.unchecked, promote: !args.noPromote };
    if (args.json) {
      process.stdout.write(envelope("publish", false, { ...data, reason: "no-service-configured" }, check.diagnostics));
    } else {
      process.stdout.write(`${style.bold("ready to publish")} ${style.dim("— nothing was sent")}\n`);
      process.stdout.write(`  bundle    ${artifacts.bundle.digest.slice(0, 12)}  ${String(artifacts.bundle.bytes)} bytes\n`);
      process.stdout.write(`  manifest  ${artifacts.manifest.digest.slice(0, 12)}  ${String(artifacts.manifest.bytes)} bytes\n`);
      process.stdout.write(
        `  archive   ${archive.digest.slice(0, 12)}  ${String(artifacts.archive.bytes)} bytes, ${String(artifacts.archive.entries)} files\n`
      );
      process.stdout.write(`${style.dim(`excluded by construction: ${archive.excluded.join(", ") || "nothing"}`)}\n`);
      for (const item of check.unchecked) process.stdout.write(`${style.dim(`unchecked here — only the platform can answer: ${item}`)}\n`);
      process.stderr.write(
        `${style.red("error")} no Agent Service is configured.\n${style.dim("Set NYLO_AGENT_SERVICE_URL to publish.")}\n`
      );
    }
    return 2;
  }
  if (service.token === undefined) {
    if (args.json) {
      process.stdout.write(envelope("publish", false, { artifacts, reason: "no-service-token" }, check.diagnostics));
    } else {
      process.stderr.write(
        `${style.red("error")} no Agent Service credential is configured.\n${style.dim("Set NYLO_AGENT_SERVICE_TOKEN to publish.")}\n`
      );
    }
    return 2;
  }

  return upload(service.url, service.token, manifest, bundle, archive.data, args, artifacts);
}

export async function upload(
  service: string,
  token: string,
  manifest: CapabilityManifest,
  bundle: Uint8Array,
  archive: Uint8Array,
  args: Args,
  artifacts: unknown
): Promise<number> {
  const style = styleFor(process.stdout.isTTY === true && !args.json);
  const form = new FormData();
  form.set("manifest", new Blob([JSON.stringify(manifest)], { type: "application/json" }), "nylo.manifest.json");
  form.set("bundle", new Blob([bundle as BlobPart], { type: "text/javascript" }), "agent.mjs");
  form.set("archive", new Blob([archive as BlobPart], { type: "application/gzip" }), "authoring.tgz");

  const response = await fetch(new URL("/agents", service), {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    if (args.json) process.stdout.write(envelope("publish", false, { status: response.status, body, artifacts }));
    else process.stderr.write(`${style.red("error")} the service refused the publish (${String(response.status)}).\n${text}\n`);
    return 1;
  }

  if (args.noPromote) {
    if (args.json) process.stdout.write(envelope("publish", true, { status: response.status, body, artifacts, promoted: false }));
    else process.stdout.write(`${style.bold("published")} ${style.dim(JSON.stringify(body))} ${style.dim("— stored, not promoted")}\n`);
    return 0;
  }

  const published = body as { name?: unknown; version?: unknown };
  if (typeof published.name !== "string" || typeof published.version !== "number") {
    if (args.json) process.stdout.write(envelope("publish", false, { status: response.status, body, artifacts, reason: "invalid-service-response" }));
    else process.stderr.write(`${style.red("error")} the service stored a version but returned no promotable name and version.\n`);
    return 1;
  }
  const promotionResponse = await fetch(
    new URL(
      `/agents/${encodeURIComponent(published.name)}/versions/${published.version}/promote`,
      service
    ),
    { method: "POST", headers: { authorization: `Bearer ${token}` } }
  );
  const promotionText = await promotionResponse.text();
  let promotion: unknown;
  try { promotion = JSON.parse(promotionText); }
  catch { promotion = { raw: promotionText }; }
  if (!promotionResponse.ok) {
    if (args.json) process.stdout.write(envelope("publish", false, { status: promotionResponse.status, body, promotion, artifacts, stored: true, promoted: false }));
    else process.stderr.write(`${style.red("error")} version ${published.version} was stored but promotion failed (${String(promotionResponse.status)}).\n${promotionText}\n`);
    return 1;
  }
  if (args.json) process.stdout.write(envelope("publish", true, { status: response.status, body, promotion, artifacts, promoted: true }));
  else process.stdout.write(`${style.bold("published and promoted")} ${style.dim(JSON.stringify(promotion))}\n`);
  return 0;
}
