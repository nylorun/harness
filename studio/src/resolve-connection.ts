import { access, readFile } from "node:fs/promises";
import { dirname, join, parse as parsePath } from "node:path";
import type { ResolvedConnection } from "@nylorun/agents";

// CLIENTS-CCR: Studio-local D§7.1 shim until WS-C implements
// `@nylorun/agents` `resolveConnection`. Delete this module and import
// `resolveConnection` from `@nylorun/agents` once C merges (I1).

const APPLICATION_KEY = /^[0-9a-f]{64}$/u;

export class ConnectionMissingError extends Error {
  readonly code = "connection_missing" as const;
  constructor(message: string) {
    super(message);
    this.name = "ConnectionMissingError";
  }
}

function trim(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next === undefined || next === "" ? undefined : next;
}

function hasAny(
  values: ReadonlyArray<string | undefined>,
): boolean {
  return values.some((value) => value !== undefined);
}

function requireComplete(
  source: string,
  parts: Readonly<{ url?: string; tenant?: string; key?: string }>,
  missing: string,
): asserts parts is { url: string; tenant: string; key: string } {
  if (!parts.url || !parts.tenant || !parts.key)
    throw new ConnectionMissingError(
      `connection_missing: ${source} is incomplete (${missing}). Tried options, environment, and project-link.`,
    );
}

async function fromOptions(options: {
  url?: string;
  tenant?: string;
  key?: string;
}): Promise<ResolvedConnection | undefined> {
  const url = trim(options.url);
  const tenant = trim(options.tenant);
  const key = trim(options.key);
  if (!hasAny([url, tenant, key])) return undefined;
  requireComplete("options", { url, tenant, key }, "need url, tenant, and key");
  return {
    url: url.replace(/\/$/u, ""),
    tenant,
    key,
    role: "application",
    source: "options",
  };
}

function fromEnvironment(
  env: NodeJS.ProcessEnv,
): ResolvedConnection | undefined {
  const url = trim(env.NYLORUN_RUNTIME_URL);
  const tenant = trim(env.NYLORUN_TENANT);
  const applicationKey = trim(env.NYLORUN_SERVER_KEY);
  const executorKey = trim(env.NYLORUN_EXECUTOR_KEY);
  if (!hasAny([url, tenant, applicationKey, executorKey])) return undefined;
  const key = executorKey ?? applicationKey;
  const role = executorKey !== undefined ? "executor" : "application";
  requireComplete(
    "environment",
    { url, tenant, key },
    "need NYLORUN_RUNTIME_URL, NYLORUN_TENANT, and NYLORUN_SERVER_KEY or NYLORUN_EXECUTOR_KEY",
  );
  return {
    url: url.replace(/\/$/u, ""),
    tenant,
    key,
    role,
    source: "environment",
  };
}

async function readJson(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return undefined;
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function findProjectLinkDir(start: string): Promise<string | undefined> {
  let current = start;
  for (;;) {
    const candidate = join(current, ".nylorun");
    try {
      await access(join(candidate, "link.json"));
      return candidate;
    } catch {
      /* keep walking */
    }
    const parent = dirname(current);
    if (parent === current || parsePath(current).root === current) return undefined;
    current = parent;
  }
}

async function fromProjectLink(
  cwd: string,
): Promise<ResolvedConnection | undefined> {
  const dir = await findProjectLinkDir(cwd);
  if (dir === undefined) return undefined;
  const link = await readJson(join(dir, "link.json"));
  const credentials = await readJson(join(dir, "credentials.json"));
  const hostUrl =
    typeof link?.hostUrl === "string" ? trim(link.hostUrl) : undefined;
  const tenantId =
    typeof link?.tenantId === "string" ? trim(link.tenantId) : undefined;
  const applicationKey =
    typeof credentials?.applicationKey === "string"
      ? trim(credentials.applicationKey)
      : undefined;
  if (!hostUrl || !tenantId || !applicationKey)
    throw new ConnectionMissingError(
      "connection_missing: project-link is incomplete (need hostUrl, tenantId, and applicationKey). Tried options, environment, and project-link.",
    );
  if (!APPLICATION_KEY.test(applicationKey))
    throw new ConnectionMissingError(
      "connection_missing: project-link credentials.applicationKey must be 64 lowercase hex characters. Tried options, environment, and project-link.",
    );
  return {
    url: hostUrl.replace(/\/$/u, ""),
    tenant: tenantId,
    key: applicationKey,
    role: "application",
    source: "project-link",
  };
}

/** Resolve a Runtime connection for Studio (D§7.1). */
export async function resolveConnection(options?: {
  url?: string;
  tenant?: string;
  key?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolvedConnection> {
  const fromOpts = await fromOptions(options ?? {});
  if (fromOpts) return fromOpts;

  const fromEnv = fromEnvironment(options?.env ?? process.env);
  if (fromEnv) return fromEnv;

  const fromLink = await fromProjectLink(options?.cwd ?? process.cwd());
  if (fromLink) return fromLink;

  throw new ConnectionMissingError(
    "connection_missing: no connection from options, environment, or project-link.",
  );
}
