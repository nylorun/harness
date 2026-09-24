import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  isTenantId,
} from "@nylorun/agents";
import { CliError } from "../errors.js";
import type { AdminTenant } from "../host/admin-client.js";
import {
  hostPaths,
  readHostCredentials,
  resolveHostRoot,
} from "../host/root.js";
import { ensureHost, hostStatus } from "../host/lifecycle.js";
import {
  readCredentials,
  removeCredentials,
} from "../project/credentials.js";
import {
  readLink,
  removeLink,
  writeLink,
} from "../project/link.js";
import { requireProjectRoot } from "../project/root.js";

function adminHeaders(adminKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${adminKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    Accept: "application/json",
  };
}

function tenantHeaders(key: string, tenantId: string): Record<string, string> {
  return {
    authorization: `Bearer ${key}`,
    [TENANT_HEADER]: tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
  };
}

async function requireHostAndAdmin(): Promise<{
  url: string;
  adminKey: string;
  hostId: string;
}> {
  const status = await hostStatus();
  if (status.state !== "running") {
    await ensureHost({ autostart: true });
  }
  const running = await hostStatus();
  if (running.state !== "running") {
    throw new CliError(
      `No Runtime Host is listening. Start one with "nylorun runtime up".`,
      6,
    );
  }
  const paths = hostPaths(resolveHostRoot());
  const creds = await readHostCredentials(paths);
  if (!creds) {
    throw new CliError(
      `Missing host-credentials.json under ${paths.root}.`,
      1,
    );
  }
  const hostId = running.hostId ?? running.config?.hostId;
  if (!hostId) {
    throw new CliError(`Host at ${running.url} did not report hostId.`, 1);
  }
  return { url: running.url.replace(/\/$/, ""), adminKey: creds.adminKey, hostId };
}

async function listTenants(
  url: string,
  adminKey: string,
): Promise<AdminTenant[]> {
  const response = await fetch(`${url}/v1/admin/tenants`, {
    headers: adminHeaders(adminKey),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) {
    throw new CliError(`Admin list tenants failed (${response.status}).`, 1);
  }
  return (await response.json()) as AdminTenant[];
}

/** Exact-and-unique name or id match (F7). */
export function matchTenant(
  tenants: readonly AdminTenant[],
  nameOrId: string,
): AdminTenant {
  if (isTenantId(nameOrId)) {
    const byId = tenants.find((t) => t.id === nameOrId);
    if (!byId) throw new CliError(`No Tenant with id ${nameOrId}.`, 1);
    return byId;
  }
  const matches = tenants.filter((t) => t.name === nameOrId);
  if (matches.length === 0) {
    throw new CliError(`No Tenant named ${JSON.stringify(nameOrId)}.`, 1);
  }
  if (matches.length > 1) {
    throw new CliError(
      `Tenant name ${JSON.stringify(nameOrId)} is not unique (${matches.length} matches). Use the Tenant id.`,
      1,
    );
  }
  return matches[0]!;
}

export async function tenantCommand(args: readonly string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (!verb || verb === "--help" || verb === "-h") {
    console.log(
      `nylorun tenant current|list [--json]|use <name-or-id>|status [--json]|reset [--sessions|--sandboxes|--all] [--yes]|delete <name-or-id> [--yes]`,
    );
    return;
  }

  if (verb === "current") {
    const root = requireProjectRoot();
    const link = await readLink(root);
    if (!link) {
      console.log("No Project link. Run nylorun dev to create one.");
      return;
    }
    const { url, adminKey } = await requireHostAndAdmin();
    const tenants = await listTenants(url, adminKey);
    const match = tenants.find((t) => t.id === link.tenantId);
    const name = match?.name ?? match?.envelope?.name ?? "(unknown)";
    console.log(`${name}  ${link.tenantId}`);
    console.log(`Host  ${link.hostUrl}  ${link.hostId}`);
    return;
  }

  if (verb === "list") {
    const json = rest.includes("--json");
    if (rest.some((a) => a !== "--json")) {
      throw new CliError("Usage: nylorun tenant list [--json]", 2);
    }
    const { url, adminKey } = await requireHostAndAdmin();
    const tenants = await listTenants(url, adminKey);
    if (json) {
      console.log(JSON.stringify(tenants, null, 2));
      return;
    }
    if (tenants.length === 0) {
      console.log("No Tenants on this Host.");
      return;
    }
    for (const tenant of tenants) {
      const name = tenant.name ?? "(unreadable)";
      console.log(`${name}  ${tenant.id}  ${tenant.state}`);
    }
    return;
  }

  if (verb === "use") {
    const nameOrId = rest[0];
    if (!nameOrId || rest.length > 1) {
      throw new CliError("Usage: nylorun tenant use <name-or-id>", 2);
    }
    const root = requireProjectRoot();
    const { url, adminKey, hostId } = await requireHostAndAdmin();
    const tenants = await listTenants(url, adminKey);
    const selected = matchTenant(tenants, nameOrId);
    console.warn(
      "Sharing a Tenant shares executor registrations across Projects that link to it.",
    );
    const credentials = await readCredentials(root);
    if (!credentials) {
      throw new CliError(
        "No Project credentials. Run nylorun dev to create a Tenant first, or copy credentials for the target Tenant.",
        1,
      );
    }
    const probe = await fetch(`${url}/v1/tenant`, {
      headers: tenantHeaders(credentials.applicationKey, selected.id),
      signal: AbortSignal.timeout(5_000),
    });
    if (!probe.ok) {
      throw new CliError(
        `Credentials do not authorize Tenant ${selected.id}. Create a new Tenant with nylorun dev instead of reusing another Project's Tenant without its key.`,
        1,
      );
    }
    await writeLink(root, {
      hostUrl: url,
      hostId,
      tenantId: selected.id,
    });
    console.log(
      `Linked to ${selected.name ?? selected.id}  ${selected.id}`,
    );
    return;
  }

  if (verb === "status") {
    const json = rest.includes("--json");
    if (rest.some((a) => a !== "--json")) {
      throw new CliError("Usage: nylorun tenant status [--json]", 2);
    }
    const root = requireProjectRoot();
    const link = await readLink(root);
    const credentials = await readCredentials(root);
    if (!link || !credentials) {
      throw new CliError(
        "No Project link. Run nylorun dev to create one.",
        1,
      );
    }
    const { url, adminKey } = await requireHostAndAdmin();
    const response = await fetch(`${url}/v1/tenant`, {
      headers: tenantHeaders(credentials.applicationKey, link.tenantId),
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) {
      const body = await response.json();
      if (json) {
        console.log(JSON.stringify(body, null, 2));
        return;
      }
      const status = body as {
        tenant: { name: string; id: string };
        path: string;
        checks: Record<string, boolean>;
        counts: Record<string, number>;
        sandbox: { backend: string | null };
      };
      console.log(`${status.tenant.name}  ${status.tenant.id}`);
      console.log(`path     ${status.path}`);
      console.log(
        `checks   ${Object.entries(status.checks)
          .map(([k, v]) => `${k}=${v ? "ok" : "fail"}`)
          .join(" ")}`,
      );
      console.log(
        `counts   sessions=${status.counts.sessions} running=${status.counts.runningSessions} pending=${status.counts.pendingActions}`,
      );
      console.log(`sandbox  ${status.sandbox.backend ?? "none"}`);
      return;
    }
    // Quarantined / opaque — fall back to admin status (F7).
    const admin = await fetch(`${url}/v1/admin/tenants/${link.tenantId}`, {
      headers: adminHeaders(adminKey),
      signal: AbortSignal.timeout(5_000),
    });
    if (!admin.ok) {
      throw new CliError(
        `Tenant ${link.tenantId} is not reachable (${response.status}).`,
        1,
      );
    }
    const body = (await admin.json()) as {
      id: string;
      name: string | null;
      state: string;
      quarantine?: { code: string; message: string; repair: string };
    };
    if (json) {
      console.log(JSON.stringify(body, null, 2));
      return;
    }
    console.log(`${body.name ?? "(unreadable)"}  ${body.id}  ${body.state}`);
    if (body.quarantine) {
      console.log(`reason   ${body.quarantine.code}: ${body.quarantine.message}`);
      console.log(`repair   ${body.quarantine.repair}`);
    }
    return;
  }

  if (verb === "reset") {
    const yes = rest.includes("--yes");
    const flags = rest.filter((a) => a !== "--yes");
    let scope: "sessions" | "sandboxes" | "all" = "sessions";
    if (flags.includes("--all")) scope = "all";
    else if (flags.includes("--sandboxes")) scope = "sandboxes";
    else if (flags.includes("--sessions") || flags.length === 0)
      scope = "sessions";
    else throw new CliError(
      "Usage: nylorun tenant reset [--sessions|--sandboxes|--all] [--yes]",
      2,
    );
    if (
      flags.filter((f) =>
        ["--sessions", "--sandboxes", "--all"].includes(f),
      ).length > 1
    ) {
      throw new CliError("Pass only one of --sessions, --sandboxes, --all.", 2);
    }
    const root = requireProjectRoot();
    const link = await readLink(root);
    const credentials = await readCredentials(root);
    if (!link || !credentials) {
      throw new CliError("No Project link. Run nylorun dev first.", 1);
    }
    const { url, adminKey } = await requireHostAndAdmin();
    const tenants = await listTenants(url, adminKey);
    const match = tenants.find((t) => t.id === link.tenantId);
    const name = match?.name ?? link.tenantId;
    const tenantPath = `${hostPaths(resolveHostRoot()).tenants}/${link.tenantId}`;
    if (scope === "all" && !yes) {
      await confirmOrThrow(
        `Reset ALL data for Tenant ${name} (${link.tenantId}) at ${tenantPath}? Link and credentials are kept. [y/N] `,
      );
    }
    const response = await fetch(`${url}/v1/tenant/reset`, {
      method: "POST",
      headers: {
        ...tenantHeaders(credentials.applicationKey, link.tenantId),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: randomUUID(),
        scope,
        activeWork: "drain",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new CliError(
        `Tenant reset failed (${response.status}): ${await response.text().catch(() => "")}`,
        1,
      );
    }
    console.log(`Reset Tenant ${name} (${scope}).`);
    return;
  }

  if (verb === "delete") {
    const yes = rest.includes("--yes");
    const nameOrId = rest.find((a) => a !== "--yes");
    if (!nameOrId || rest.filter((a) => a !== "--yes").length !== 1) {
      throw new CliError("Usage: nylorun tenant delete <name-or-id> [--yes]", 2);
    }
    const root = requireProjectRoot();
    const { url, adminKey } = await requireHostAndAdmin();
    const tenants = await listTenants(url, adminKey);
    const selected = matchTenant(tenants, nameOrId);
    const tenantPath = `${hostPaths(resolveHostRoot()).tenants}/${selected.id}`;
    if (!yes) {
      await confirmOrThrow(
        `Delete Tenant ${selected.name ?? selected.id} (${selected.id}) at ${tenantPath}?\nThe KEK moves to trash with the Tenant directory. [y/N] `,
      );
    }
    const response = await fetch(
      `${url}/v1/admin/tenants/${selected.id}?activeWork=refuse`,
      {
        method: "DELETE",
        headers: adminHeaders(adminKey),
        signal: AbortSignal.timeout(60_000),
      },
    );
    if (response.status === 409) {
      throw new CliError(
        `Tenant ${selected.id} has live work. Retry with the Host idle, or drain sessions first.`,
        1,
      );
    }
    if (!response.ok && response.status !== 204) {
      throw new CliError(
        `Tenant delete failed (${response.status}): ${await response.text().catch(() => "")}`,
        1,
      );
    }
    const link = await readLink(root);
    if (link?.tenantId === selected.id) {
      await removeLink(root);
      await removeCredentials(root);
      console.log("Removed Project link and credentials for the deleted Tenant.");
    }
    console.log(`Deleted Tenant ${selected.name ?? selected.id}.`);
    return;
  }

  throw new CliError(
    `Unknown tenant command ${verb}.\nUsage: nylorun tenant current|list|use|status|reset|delete`,
    2,
  );
}

async function confirmOrThrow(prompt: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new CliError("Confirmation required; pass --yes for non-interactive use.", 2);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(prompt)).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      throw new CliError("Cancelled.", 1);
    }
  } finally {
    rl.close();
  }
}
