import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  newTenantId,
} from "@nylorun/agents";
import { CliError } from "../errors.js";
import {
  writeCredentials,
  type ProjectCredentials,
} from "./credentials.js";
import { writeLink, type ProjectLink } from "./link.js";

/** SHA-256 hex of a bearer token (matches Runtime `hashToken`). */
export function hashCredential(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function mintApplicationKey(): string {
  return randomBytes(32).toString("hex");
}

export function mintPrincipalId(): string {
  return `principal_${randomBytes(8).toString("hex")}`;
}

export interface BootstrapMaterial {
  tenantId: string;
  name: string;
  principalId: string;
  applicationKey: string;
  idempotencyKey: string;
}

export function generateBootstrap(name: string): BootstrapMaterial {
  return {
    tenantId: newTenantId(),
    name,
    principalId: mintPrincipalId(),
    applicationKey: mintApplicationKey(),
    idempotencyKey: randomUUID(),
  };
}

export interface CreateTenantOptions {
  hostUrl: string;
  hostId: string;
  adminKey: string;
  projectRoot: string;
  name?: string;
  fetchImpl?: typeof fetch;
}

export interface CreateTenantResult {
  link: ProjectLink;
  credentials: ProjectCredentials;
  envelope: { id: string; name: string };
  created: boolean;
}

async function defaultTenantName(projectRoot: string): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as { name?: string };
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.trim();
  } catch {
    /* fall through */
  }
  const base = projectRoot.split(/[/\\]/).filter(Boolean).at(-1);
  return base && base.length > 0 ? base : "project";
}

function adminHeaders(adminKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${adminKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    Accept: "application/json",
    "content-type": "application/json",
  };
}

/**
 * Create a Tenant on the Host and write Project link + credentials only after
 * success. Lost responses retry with identical material; id collisions
 * regenerate up to three times (F2).
 */
export async function createProjectTenant(
  options: CreateTenantOptions,
): Promise<CreateTenantResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const name = options.name ?? (await defaultTenantName(options.projectRoot));
  const hostUrl = options.hostUrl.replace(/\/$/, "");
  let material = generateBootstrap(name);
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) material = generateBootstrap(name);
    const body = {
      tenantId: material.tenantId,
      name: material.name,
      principalId: material.principalId,
      credentialHash: hashCredential(material.applicationKey),
      idempotencyKey: material.idempotencyKey,
    };

    let response: Response | undefined;
    for (let retry = 0; retry < 3; retry += 1) {
      try {
        response = await fetchImpl(`${hostUrl}/v1/admin/tenants`, {
          method: "POST",
          headers: adminHeaders(options.adminKey),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(15_000),
        });
        break;
      } catch (error) {
        lastError = error;
        // Lost response: retry with identical material (F2).
        if (retry === 2) throw error;
      }
    }
    if (!response) throw lastError ?? new Error("Tenant create failed");

    if (response.status === 409) {
      lastError = new CliError(
        `Tenant id collision for ${material.tenantId}; regenerating.`,
        1,
      );
      continue;
    }

    if (response.status !== 201 && response.status !== 200) {
      const text = await response.text().catch(() => "");
      throw new CliError(
        `Could not create Tenant on ${hostUrl} (${response.status}): ${text}`,
        1,
      );
    }

    const envelope = (await response.json()) as {
      id: string;
      name: string;
    };
    const credentials: ProjectCredentials = {
      applicationKey: material.applicationKey,
      principalId: material.principalId,
      executors: {},
    };
    const link: ProjectLink = {
      hostUrl,
      hostId: options.hostId,
      tenantId: envelope.id,
    };
    // Write credentials then link so a torn write never leaves a link without keys.
    await writeCredentials(options.projectRoot, credentials);
    await writeLink(options.projectRoot, link);
    return {
      link,
      credentials,
      envelope: { id: envelope.id, name: envelope.name },
      created: response.status === 201,
    };
  }

  throw (
    lastError ??
    new CliError(
      "Could not create a Tenant after three id collisions. Try again.",
      1,
    )
  );
}
