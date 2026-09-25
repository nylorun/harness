/**
 * Write a fake Host entry for launcher lifecycle tests. The stub reads
 * host.json from NYLORUN_HOME and serves /health, /ready, and admin
 * shutdown/status, standing in for `@nylorun/runtime`'s dist/host/main.js.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FakeHostOptions {
  version: string;
  /** Delay /ready until this many ms (tests). */
  readyDelayMs?: number;
}

const HOST_STUB = `import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const home = process.env.NYLORUN_HOME;
if (!home) {
  console.error("NYLORUN_HOME required");
  process.exit(1);
}
const configPath = join(home, "host.json");
const credentialsPath = join(home, "host-credentials.json");
let config = { host: "127.0.0.1", port: 0, hostId: "host_0123456789abcdefghjkmnpq" };
try {
  config = { ...config, ...JSON.parse(readFileSync(configPath, "utf8")) };
} catch { /* use defaults */ }
let adminKey = "";
try {
  adminKey = JSON.parse(readFileSync(credentialsPath, "utf8")).adminKey ?? "";
} catch { /* none */ }
const version = process.env.NYLORUN_RUNTIME_VERSION ?? ${JSON.stringify("__VERSION__")};
const readyDelay = Number(process.env.NYLORUN_READY_DELAY_MS ?? "0");
let ready = false;
setTimeout(() => { ready = true; }, readyDelay);

let aggregate = {
  runningSessions: Number(process.env.NYLORUN_STUB_SESSIONS ?? "0"),
  connectedExecutors: Number(process.env.NYLORUN_STUB_EXECUTORS ?? "0"),
  pendingActions: 0,
  uncertainEffects: 0,
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const auth = req.headers.authorization ?? "";
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "nylorun-runtime",
      version,
      hostId: config.hostId,
      pid: process.pid,
      protocol: { min: 2, max: 2, features: ["runtime-tenants", "admin-status"] },
    }));
    return;
  }
  if (url.pathname === "/ready") {
    if (!ready) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "starting" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready", service: "nylorun-runtime" }));
    return;
  }
  if (url.pathname === "/v1/admin/status" || url.pathname === "/v1/admin/host") {
    if (adminKey && auth !== "Bearer " + adminKey) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "rejected", code: "not_found", message: "Not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      service: "nylorun-runtime",
      version,
      protocol: { min: 2, max: 2, features: ["runtime-tenants", "admin-status"] },
      tenants: [],
      aggregate,
      host: { hostId: config.hostId, url: "http://" + config.host + ":" + config.port, pid: process.pid },
      hostId: config.hostId,
      url: "http://" + config.host + ":" + config.port,
      pid: process.pid,
    }));
    return;
  }
  if (url.pathname === "/v1/admin/host/shutdown" && req.method === "POST") {
    if (adminKey && auth !== "Bearer " + adminKey) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    setTimeout(() => process.exit(0), 50);
    return;
  }
  // Test hook: mutate aggregate via POST /_stub/aggregate
  if (url.pathname === "/_stub/aggregate" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      try { aggregate = { ...aggregate, ...JSON.parse(body) }; } catch { /* ignore */ }
      res.writeHead(200);
      res.end("{}");
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(config.port, config.host, () => {
  process.stdout.write(JSON.stringify({ type: "listening", pid: process.pid }) + "\\n");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
`;

/** Write `host.mjs` into `dir` and return its path (the launcher's hostEntry). */
export async function writeFakeHost(
  dir: string,
  options: FakeHostOptions,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const entry = join(dir, "host.mjs");
  const stub = HOST_STUB.replace("__VERSION__", options.version).replace(
    'process.env.NYLORUN_READY_DELAY_MS ?? "0"',
    `process.env.NYLORUN_READY_DELAY_MS ?? "${options.readyDelayMs ?? 0}"`,
  );
  await writeFile(entry, stub);
  return entry;
}
