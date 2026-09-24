import { createServer } from "node:net";
import { processAlive } from "./locks.js";

export interface ProbeHealthResult {
  reachable: boolean;
  health?: {
    status: string;
    service: string;
    version?: string;
    hostId?: string;
    pid?: number;
    protocol?: { min: number; max: number; features: string[] };
  };
  /** Something answered but is not a Nylorun Runtime Host. */
  foreign?: boolean;
}

export async function probeHostHealth(
  url: string,
  timeoutMs = 2000,
): Promise<ProbeHealthResult> {
  const signal = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetch(`${url}/health`, { signal });
  } catch {
    return { reachable: false };
  }
  if (!response.ok) return { reachable: true, foreign: true };
  try {
    const body = (await response.json()) as Record<string, unknown>;
    if (body?.status !== "ok" || typeof body.service !== "string") {
      return { reachable: true, foreign: true };
    }
    if (body.service !== "oss-runtime" && body.service !== "nylorun-runtime") {
      return { reachable: true, foreign: true };
    }
    const protocol = body.protocol as
      | { min?: number; max?: number; features?: string[] }
      | undefined;
    return {
      reachable: true,
      health: {
        status: "ok",
        service: body.service,
        ...(typeof body.version === "string" ? { version: body.version } : {}),
        ...(typeof body.hostId === "string" ? { hostId: body.hostId } : {}),
        ...(typeof body.pid === "number" ? { pid: body.pid } : {}),
        ...(protocol &&
        typeof protocol.min === "number" &&
        typeof protocol.max === "number" &&
        Array.isArray(protocol.features)
          ? {
              protocol: {
                min: protocol.min,
                max: protocol.max,
                features: protocol.features.map(String),
              },
            }
          : {}),
      },
    };
  } catch {
    return { reachable: true, foreign: true };
  }
}

/** True when the address accepts a new listen (nothing bound). */
export async function portBindable(
  host: string,
  port: number,
): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolvePromise) => {
    server.once("error", () => resolvePromise(false));
    server.listen(port, host, () => server.close(() => resolvePromise(true)));
  });
}

export async function probeReady(
  url: string,
  timeoutMs = 2000,
): Promise<boolean> {
  try {
    const response = await fetch(`${url}/ready`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: string };
    return body.status === "ready";
  } catch {
    return false;
  }
}

export { processAlive };
