import { release } from "node:os";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  createClient,
  resolveConnection,
  type AgentManifest,
} from "@nylorun/agents";
import { CliError } from "./errors.js";

const LABEL: Record<string, string> = {
  microsandbox: "microsandbox VM",
  virtual: "virtual shell",
};

export type SandboxReport = {
  preference: string;
  backend: string | null;
  isolation?: string;
  reason?: string;
  probes: {
    name: string;
    isolation: string;
    available: boolean;
    reason?: string;
    version?: string;
  }[];
  defaultImage?: string;
};

function platformLine(): string {
  const os =
    process.platform === "darwin"
      ? "macOS"
      : process.platform === "win32"
        ? "Windows"
        : process.platform;
  return `${os} (kernel ${release()}) · ${process.arch}`;
}

async function fetchSandboxReport(options?: {
  url?: string;
  key?: string;
  tenant?: string;
}): Promise<SandboxReport> {
  const connection = await resolveConnection(options);
  const client = createClient({
    url: connection.url,
    key: connection.key,
    tenant: connection.tenant,
  });
  return client.transport.json<SandboxReport>(
    "/v1/tenant/sandbox",
    "GET",
    undefined,
  );
}

/** `nylorun doctor sandbox`: Tenant sandbox report via the Tenant API (F2-4). */
export async function doctorSandbox(options: { json: boolean }): Promise<void> {
  let report: SandboxReport;
  try {
    report = await fetchSandboxReport();
  } catch (error) {
    throw new CliError(
      error instanceof Error
        ? error.message
        : `Could not read Tenant sandbox status: ${String(error)}`,
      1,
    );
  }
  if (options.json) {
    console.log(
      JSON.stringify({ platform: platformLine(), ...report }, null, 2),
    );
    return;
  }
  const rows: [string, string][] = [["platform", platformLine()]];
  for (const probe of report.probes)
    rows.push([
      probe.name,
      `${probe.available ? "✓" : "✗"} ${probe.reason ?? ""}${probe.version ? ` · ${probe.version}` : ""}`,
    ]);
  rows.push([
    "preference",
    report.preference === "auto"
      ? "auto (seed Tenant sandbox.backend via nylorun dev / .env NYLORUN_SANDBOX)"
      : report.preference,
  ]);
  rows.push([
    "selected",
    report.backend
      ? `${report.backend} (${report.isolation} isolation)`
      : `none: ${report.reason}`,
  ]);
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  for (const [key, value] of rows)
    console.log(`  ${key.padEnd(width)}${value}`);
  if (report.backend === "virtual")
    console.log(
      "\n  The virtual shell emulates bash in the Runtime process; it is not a VM boundary.\n" +
        "  For hardware isolation use macOS on Apple Silicon or Linux with KVM.",
    );
}

/** One line for the dev banner, or undefined when no connected agent declares a sandbox. */
export async function sandboxBanner(
  runtimeUrl: string,
  serverKey: string,
  manifests: readonly AgentManifest[],
  tenantId: string,
): Promise<string | undefined> {
  const capability = manifests
    .flatMap((manifest) => manifest.capabilities)
    .find((item) => item.sandbox);
  if (!capability) return undefined;
  let report: SandboxReport | undefined;
  try {
    const response = await fetch(`${runtimeUrl}/v1/tenant/sandbox`, {
      headers: {
        authorization: `Bearer ${serverKey}`,
        [TENANT_HEADER]: tenantId,
        [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok) report = (await response.json()) as SandboxReport;
  } catch {
    /* ignore */
  }
  if (!report) return undefined;
  const doctor = "run `npx nylorun doctor sandbox` for options";
  if (!report.backend)
    return `sandbox: unavailable (${report.reason}) · ${doctor}`;
  const image = capability.sandbox?.image ?? report.defaultImage;
  const network = capability.sandbox?.network?.preset ?? "dev";
  const fellBack =
    report.preference === "auto" && report.backend !== report.probes[0]?.name;
  return fellBack
    ? `sandbox: ${LABEL[report.backend] ?? report.backend} (${report.reason}) · ${doctor}`
    : `sandbox: ${LABEL[report.backend] ?? report.backend}${report.backend === "microsandbox" && image ? ` · image ${image}` : ""} · network: ${network}`;
}
