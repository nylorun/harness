import { release } from "node:os";
import {
  probeSandboxBackends,
  type SandboxSelectionReport,
} from "@nylorun/runtime/node";
import type { AgentManifest } from "@nylorun/agents";

const LABEL: Record<string, string> = {
  microsandbox: "microsandbox VM",
  virtual: "virtual shell",
};

/** `nylorun doctor sandbox`: what this machine offers and what a Runtime here would pick. */
export async function doctorSandbox(options: { json: boolean }): Promise<void> {
  const report = await probeSandboxBackends();
  if (options.json) {
    console.log(JSON.stringify({ platform: platform(), ...report }, null, 2));
    return;
  }
  const rows: [string, string][] = [["platform", platform()]];
  for (const probe of report.probes)
    rows.push([
      probe.name,
      `${probe.available ? "✓" : "✗"} ${probe.reason ?? ""}${probe.version ? ` · ${probe.version}` : ""}`,
    ]);
  rows.push(["preference", report.preference === "auto" ? "auto (set NYLORUN_SANDBOX to force one)" : report.preference]);
  rows.push(["selected", report.backend ? `${report.backend} (${report.isolation} isolation)` : `none: ${report.reason}`]);
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  for (const [key, value] of rows) console.log(`  ${key.padEnd(width)}${value}`);
  if (report.backend === "virtual")
    console.log(
      "\n  The virtual shell emulates bash in the Runtime process; it is not a VM boundary.\n" +
        "  For hardware isolation use macOS on Apple Silicon or Linux with KVM."
    );
}

/** One line for the dev banner, or undefined when no connected agent declares a sandbox. */
export async function sandboxBanner(
  runtimeUrl: string,
  serverKey: string,
  manifests: readonly AgentManifest[]
): Promise<string | undefined> {
  const capability = manifests
    .flatMap((manifest) => manifest.capabilities)
    .find((item) => item.sandbox);
  if (!capability) return undefined;
  let report: (SandboxSelectionReport & { defaultImage?: string }) | undefined;
  try {
    const response = await fetch(`${runtimeUrl}/v1/host/sandbox`, {
      headers: { authorization: `Bearer ${serverKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) report = await response.json();
  } catch {}
  if (!report) return undefined;
  const doctor = "run `npx nylorun doctor sandbox` for options";
  if (!report.backend) return `sandbox: unavailable (${report.reason}) · ${doctor}`;
  const image = capability.sandbox?.image ?? report.defaultImage;
  const network = capability.sandbox?.network?.preset ?? "dev";
  const fellBack = report.preference === "auto" && report.backend !== report.probes[0]?.name;
  return fellBack
    ? `sandbox: ${LABEL[report.backend] ?? report.backend} (${report.reason}) · ${doctor}`
    : `sandbox: ${LABEL[report.backend] ?? report.backend}${report.backend === "microsandbox" && image ? ` · image ${image}` : ""} · network: ${network}`;
}

function platform(): string {
  const os = process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : process.platform;
  return `${os} (kernel ${release()}) · ${process.arch}`;
}
