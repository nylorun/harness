import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  type ProtocolRange,
} from "@nylorun/agents";
import { CliError } from "../errors.js";

export interface AdminTenant {
  id: string;
  name: string | null;
  state: "open" | "quarantined";
  envelope: {
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    schemaVersion: number;
  } | null;
}

export interface AdminHostStatus {
  hostId: string;
  url: string;
  pid: number;
  version: string;
  protocol: ProtocolRange;
  tenants: AdminTenant[];
  aggregate: {
    runningSessions: number;
    connectedExecutors: number;
    pendingActions: number;
    uncertainEffects: number;
  };
}

export interface AdminClientOptions {
  url: string;
  adminKey: string;
  fetchImpl?: typeof fetch;
}

function adminHeaders(adminKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${adminKey}`,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    Accept: "application/json",
  };
}

export async function fetchAdminHost(
  options: AdminClientOptions,
): Promise<AdminHostStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${options.url}/v1/admin/host`, {
      headers: adminHeaders(options.adminKey),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new CliError(
      `Could not reach the Runtime Host admin API at ${options.url}: ${error instanceof Error ? error.message : String(error)}`,
      1,
    );
  }
  if (!response.ok) {
    throw new CliError(
      `Admin host status failed (${response.status}) at ${options.url}.`,
      1,
    );
  }
  const body = (await response.json()) as AdminHostStatus;
  if (
    typeof body?.hostId !== "string" ||
    typeof body.pid !== "number" ||
    !body.aggregate ||
    !Array.isArray(body.tenants)
  ) {
    throw new CliError(
      `Admin host status response from ${options.url} was malformed.`,
      1,
    );
  }
  return body;
}

export async function requestAdminShutdown(
  options: AdminClientOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    await fetchImpl(`${options.url}/v1/admin/host/shutdown`, {
      method: "POST",
      headers: adminHeaders(options.adminKey),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    /* SIGTERM path still runs */
  }
}

/** Poll until aggregate has no running sessions or connected executors. */
export async function waitForIdle(
  options: AdminClientOptions & {
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<AdminHostStatus> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  let last: AdminHostStatus | undefined;
  while (Date.now() < deadline) {
    last = await fetchAdminHost(options);
    if (
      last.aggregate.runningSessions === 0 &&
      last.aggregate.connectedExecutors === 0
    ) {
      return last;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const sessions = last?.aggregate.runningSessions ?? "?";
  const executors = last?.aggregate.connectedExecutors ?? "?";
  throw new CliError(
    `Timed out waiting for the Host to become idle (${sessions} running session(s), ${executors} connected executor(s)). Pass --force to stop anyway.`,
    1,
  );
}
