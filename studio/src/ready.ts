import type { ResolvedConnection } from "@nylorun/agents";
import { resolveConnection } from "./resolve-connection.js";

export class StudioRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StudioRoleError";
  }
}

export const WAITING_MESSAGE = "Waiting for nylorun dev…";

export type ReadyDeps = Readonly<{
  resolveConnection?: typeof resolveConnection;
  fetchHealth?: (url: string) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  intervalMs?: number;
}>;

async function defaultFetchHealth(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url.replace(/\/$/u, "")}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until an application connection resolves and `/health` answers (D14).
 * Prints the waiting line once. Rejects executor role immediately.
 */
export async function waitForApplicationConnection(
  deps: ReadyDeps = {},
): Promise<ResolvedConnection> {
  const resolve = deps.resolveConnection ?? resolveConnection;
  const fetchHealth = deps.fetchHealth ?? defaultFetchHealth;
  const sleep = deps.sleep ?? defaultSleep;
  const log = deps.log ?? ((message) => console.log(message));
  const intervalMs = deps.intervalMs ?? 2000;
  let announced = false;

  for (;;) {
    try {
      const connection = await resolve();
      if (connection.role === "executor") {
        throw new StudioRoleError(
          "Studio requires an application connection. Unset NYLORUN_EXECUTOR_KEY and use NYLORUN_SERVER_KEY or the Project link application key.",
        );
      }
      if (await fetchHealth(connection.url)) return connection;
    } catch (error) {
      if (error instanceof StudioRoleError) throw error;
    }
    if (!announced) {
      log(WAITING_MESSAGE);
      announced = true;
    }
    await sleep(intervalMs);
  }
}
