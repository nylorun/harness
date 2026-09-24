import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface StubHostOptions {
  hostId?: string;
  version?: string;
  protocol?: { min: number; max: number; features: string[] };
  adminKey?: string;
  aggregate?: {
    runningSessions: number;
    connectedExecutors: number;
    pendingActions: number;
    uncertainEffects: number;
  };
  tenants?: Array<{
    id: string;
    name: string | null;
    state: "open" | "quarantined";
    envelope: null;
  }>;
}

export async function temporaryRoot(prefix = "nylorun-host-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

/** Minimal Host that speaks /health, /ready and admin routes for CLI tests. */
export async function startStubHost(
  options: StubHostOptions = {},
): Promise<{
  url: string;
  host: string;
  port: number;
  hostId: string;
  adminKey: string;
  close: () => Promise<void>;
  setAggregate: (aggregate: NonNullable<StubHostOptions["aggregate"]>) => void;
}> {
  const hostId = options.hostId ?? "host_0123456789abcdefghjkmnpq";
  const adminKey = options.adminKey ?? "a".repeat(64);
  const version = options.version ?? "0.9.0-beta";
  const protocol = options.protocol ?? {
    min: 2,
    max: 2,
    features: ["runtime-tenants"],
  };
  let aggregate = options.aggregate ?? {
    runningSessions: 0,
    connectedExecutors: 0,
    pendingActions: 0,
    uncertainEffects: 0,
  };
  const tenants = options.tenants ?? [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "nylorun-runtime-host",
          version,
          protocol,
          coreVersion: "0.4.0-beta",
          hostId,
          pid: process.pid,
        }),
      );
      return;
    }
    if (url.pathname === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          service: "nylorun-runtime-host",
          checks: { listener: true, discovery: true },
        }),
      );
      return;
    }
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${adminKey}`) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "rejected",
          code: "not_found",
          message: "Not found",
        }),
      );
      return;
    }
    if (url.pathname === "/v1/admin/host" && req.method === "GET") {
      const port = (server.address() as { port: number }).port;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          hostId,
          url: `http://127.0.0.1:${port}`,
          pid: process.pid,
          version,
          protocol,
          tenants,
          aggregate,
        }),
      );
      return;
    }
    if (url.pathname === "/v1/admin/host/shutdown" && req.method === "POST") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("stub host failed to bind");
  }
  const { port } = address;
  return {
    url: `http://127.0.0.1:${port}`,
    host: "127.0.0.1",
    port,
    hostId,
    adminKey,
    setAggregate: (next) => {
      aggregate = next;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Foreign HTTP listener that is not a Runtime Host. */
export async function startForeignListener(): Promise<{
  host: string;
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("not-nylorun");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("foreign listener failed to bind");
  }
  return {
    host: "127.0.0.1",
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
