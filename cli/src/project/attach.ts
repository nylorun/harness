import { createInterface } from "node:readline/promises";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/agents";
import { CliError } from "../errors.js";
import type { AdminTenant } from "../host/admin-client.js";
import {
  readHostCredentials,
  hostPaths,
  resolveHostRoot,
} from "../host/root.js";
import {
  ensureHost,
  hostStatus,
  type HostStatus,
} from "../host/lifecycle.js";
import {
  readCredentials,
  removeCredentials,
  type ProjectCredentials,
} from "./credentials.js";
import { createProjectTenant } from "./create-tenant.js";
import {
  readLink,
  removeLink,
  writeLink,
  type ProjectLink,
} from "./link.js";

export interface AttachedProject {
  projectRoot: string;
  link: ProjectLink;
  credentials: ProjectCredentials;
  host: HostStatus;
  tenantName: string;
  hostStarted: boolean;
}

export interface AttachOptions {
  projectRoot: string;
  autostart?: boolean;
  ephemeral?: boolean;
  /** Interactive stdin; defaults to process.stdin when TTY. */
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  fetchImpl?: typeof fetch;
}

function tenantHeaders(
  key: string,
  tenantId: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
}

async function probeTenant(
  hostUrl: string,
  tenantId: string,
  applicationKey: string,
  fetchImpl: typeof fetch,
): Promise<"ok" | "rejected"> {
  try {
    const response = await fetchImpl(`${hostUrl}/v1/tenant`, {
      headers: tenantHeaders(applicationKey, tenantId),
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok ? "ok" : "rejected";
  } catch {
    return "rejected";
  }
}

async function listAdminTenants(
  hostUrl: string,
  adminKey: string,
  fetchImpl: typeof fetch,
): Promise<AdminTenant[]> {
  const response = await fetchImpl(`${hostUrl}/v1/admin/tenants`, {
    headers: {
      Authorization: `Bearer ${adminKey}`,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return [];
  return (await response.json()) as AdminTenant[];
}

async function healthHostId(
  hostUrl: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`${hostUrl}/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { hostId?: string };
    return typeof body.hostId === "string" ? body.hostId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ensure a Project link exists and authenticates against the Host (F2, F6).
 */
export async function attachProject(
  options: AttachOptions,
): Promise<AttachedProject> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const projectRoot = options.projectRoot;
  const before = await hostStatus();
  const wasRunning = before.state === "running";
  const host = await ensureHost({
    autostart: options.autostart !== false,
    quiet: wasRunning,
  });
  const hostStarted = !wasRunning && host.state === "running";
  const hostUrl = host.url.replace(/\/$/, "");
  const hostId =
    host.hostId ??
    host.config?.hostId ??
    (await healthHostId(hostUrl, fetchImpl)) ??
    "";
  if (!hostId) {
    throw new CliError(
      `Runtime Host at ${hostUrl} did not report a hostId. Restart with "nylorun runtime restart".`,
      1,
    );
  }

  const paths = hostPaths(resolveHostRoot());
  const hostCreds = await readHostCredentials(paths);
  if (!hostCreds) {
    throw new CliError(
      `Missing host-credentials.json under ${paths.root}. Run "nylorun runtime up" first.`,
      1,
    );
  }

  let link = await readLink(projectRoot);
  let credentials = await readCredentials(projectRoot);

  if (!link || !credentials) {
    const created = await createProjectTenant({
      hostUrl,
      hostId,
      adminKey: hostCreds.adminKey,
      projectRoot,
      fetchImpl,
    });
    return {
      projectRoot,
      link: created.link,
      credentials: created.credentials,
      host,
      tenantName: created.envelope.name,
      hostStarted,
    };
  }

  // Existing link: verify Host identity and Tenant credentials (F6).
  if (link.hostUrl.replace(/\/$/, "") !== hostUrl) {
    // Same URL preferred; if Host moved, update URL when hostId matches.
    const liveId = await healthHostId(hostUrl, fetchImpl);
    if (liveId && liveId === link.hostId) {
      link = { ...link, hostUrl };
      await writeLink(projectRoot, link);
    }
  }

  const liveId = await healthHostId(hostUrl, fetchImpl);
  if (liveId && liveId !== link.hostId) {
    throw new CliError(
      `Project link points at Host ${link.hostId}, but ${hostUrl} is ${liveId}. Relink: remove .nylorun/link.json and run nylorun dev.`,
      1,
    );
  }

  const auth = await probeTenant(
    hostUrl,
    link.tenantId,
    credentials.applicationKey,
    fetchImpl,
  );
  if (auth === "ok") {
    const tenants = await listAdminTenants(
      hostUrl,
      hostCreds.adminKey,
      fetchImpl,
    );
    const match = tenants.find((t) => t.id === link!.tenantId);
    return {
      projectRoot,
      link: { ...link, hostUrl, hostId: liveId ?? link.hostId },
      credentials,
      host,
      tenantName: match?.name ?? match?.envelope?.name ?? link.tenantId,
      hostStarted,
    };
  }

  const tenants = await listAdminTenants(
    hostUrl,
    hostCreds.adminKey,
    fetchImpl,
  );
  const known = tenants.some((t) => t.id === link!.tenantId);
  if (known) {
    throw new CliError(
      `Application credential rejected for Tenant ${link.tenantId} on Host ${link.hostId}. Relink: remove .nylorun/link.json and .nylorun/credentials.json, then run nylorun dev.`,
      1,
    );
  }

  // Unknown Tenant — interactive recovery (F6); never reuse the id.
  const choice = await chooseUnknownTenantRecovery({
    tenantId: link.tenantId,
    tenants,
    input: options.input,
    output: options.output,
  });
  if (choice === "remove") {
    await removeLink(projectRoot);
    await removeCredentials(projectRoot);
    throw new CliError(
      "Removed Project link. Run nylorun dev again to create a new Tenant.",
      1,
    );
  }
  if (choice === "create") {
    await removeLink(projectRoot);
    await removeCredentials(projectRoot);
    const created = await createProjectTenant({
      hostUrl,
      hostId: liveId ?? hostId,
      adminKey: hostCreds.adminKey,
      projectRoot,
      fetchImpl,
    });
    return {
      projectRoot,
      link: created.link,
      credentials: created.credentials,
      host,
      tenantName: created.envelope.name,
      hostStarted,
    };
  }
  // choose another
  const selected = choice.tenant;
  await writeLink(projectRoot, {
    hostUrl,
    hostId: liveId ?? hostId,
    tenantId: selected.id,
  });
  const retry = await probeTenant(
    hostUrl,
    selected.id,
    credentials.applicationKey,
    fetchImpl,
  );
  if (retry !== "ok") {
    throw new CliError(
      `Credentials do not authorize Tenant ${selected.id}. Remove .nylorun/credentials.json and create a new Tenant with nylorun dev.`,
      1,
    );
  }
  return {
    projectRoot,
    link: {
      hostUrl,
      hostId: liveId ?? hostId,
      tenantId: selected.id,
    },
    credentials,
    host,
    tenantName: selected.name ?? selected.envelope?.name ?? selected.id,
    hostStarted,
  };
}

type RecoveryChoice =
  | "create"
  | "remove"
  | { tenant: AdminTenant };

async function chooseUnknownTenantRecovery(options: {
  tenantId: string;
  tenants: readonly AdminTenant[];
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}): Promise<RecoveryChoice> {
  const message = `Linked Tenant ${options.tenantId} is unknown on this Host.`;
  const tty =
    options.input === undefined
      ? Boolean(process.stdin.isTTY && process.stdout.isTTY)
      : true;
  if (!tty) {
    throw new CliError(
      `${message} Create a new Tenant (remove .nylorun/link.json), choose another with "nylorun tenant use", or remove the link.`,
      1,
    );
  }
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const rl = createInterface({ input, output });
  try {
    output.write(`${message}\n`);
    output.write("  1) Create a new Tenant\n");
    output.write("  2) Choose another Tenant on this Host\n");
    output.write("  3) Remove the Project link\n");
    const answer = (await rl.question("Choose [1/2/3]: ")).trim();
    if (answer === "1") return "create";
    if (answer === "3") return "remove";
    if (answer === "2") {
      const open = options.tenants.filter((t) => t.state === "open" && t.name);
      if (open.length === 0) {
        throw new CliError(
          "No open Tenants on this Host to choose. Create a new one instead.",
          1,
        );
      }
      for (let i = 0; i < open.length; i += 1) {
        const t = open[i]!;
        output.write(
          `  ${i + 1}) ${t.name ?? "(unnamed)"}  ${t.id}\n`,
        );
      }
      const pick = Number(
        (await rl.question(`Choose Tenant [1-${open.length}]: `)).trim(),
      );
      if (!Number.isInteger(pick) || pick < 1 || pick > open.length) {
        throw new CliError("Invalid Tenant choice.", 2);
      }
      return { tenant: open[pick - 1]! };
    }
    throw new CliError("Invalid choice.", 2);
  } finally {
    rl.close();
  }
}

/** Three `export` lines for `runtime status --env` (F8). */
export async function printLinkedEnvExports(
  projectRoot = process.cwd(),
): Promise<void> {
  const { findProjectRoot } = await import("./root.js");
  const root = findProjectRoot(projectRoot) ?? projectRoot;
  const link = await readLink(root);
  const credentials = await readCredentials(root);
  if (!link || !credentials) {
    console.log(
      "# No Project link in this directory. Run nylorun dev to create one.",
    );
    return;
  }
  console.log(`export NYLORUN_RUNTIME_URL=${shellQuote(link.hostUrl)}`);
  console.log(
    `export NYLORUN_SERVER_KEY=${shellQuote(credentials.applicationKey)}`,
  );
  console.log(`export NYLORUN_TENANT=${shellQuote(link.tenantId)}`);
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
