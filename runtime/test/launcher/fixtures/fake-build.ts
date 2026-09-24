/**
 * Write a fake Runtime build directory (manifest, Node symlink, Host stub).
 * The Host stub reads host.json from NYLORUN_HOME and serves /health, /ready,
 * and admin shutdown/status for launcher lifecycle tests.
 */
import {
  chmodSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeBuildManifest } from "@nylorun/core/contracts";
import type { PlatformArch } from "../../../src/launcher/builds.js";

export interface FakeBuildOptions {
  version: string;
  platform?: PlatformArch["platform"];
  arch?: PlatformArch["arch"];
  nodeVersion?: string;
  /** Extra tenantSchema.max (default 1). */
  tenantSchemaMax?: number;
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

const LAUNCHER_STUB = `#!/usr/bin/env node
console.error("fixture launcher stub; use the workspace launcher under test");
process.exit(2);
`;

/**
 * Write a fake Runtime build directory (manifest, Node symlink, Host stub).
 * Owned by WS-E; WS-F1 may import it until WS-G lands.
 */
export async function writeFakeBuild(
  dir: string,
  options: FakeBuildOptions,
): Promise<{
  dir: string;
  manifest: RuntimeBuildManifest;
  entry: string;
  launcher: string;
}> {
  const platform =
    options.platform ?? (process.platform as PlatformArch["platform"]);
  const arch = options.arch ?? (process.arch as PlatformArch["arch"]);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const entry = "lib/node_modules/@nylorun/runtime/dist/host/main.js";
  const launcher = "lib/node_modules/@nylorun/runtime/dist/launcher/main.js";

  const manifest: RuntimeBuildManifest = {
    format: 1,
    runtimeVersion: options.version,
    platform:
      platform === "darwin" || platform === "linux" || platform === "win32"
        ? platform
        : "linux",
    arch: arch === "arm64" || arch === "x64" ? arch : "x64",
    node: { version: nodeVersion },
    entry,
    launcher,
    launcherProtocol: 1,
    protocol: {
      min: 2,
      max: 2,
      features: ["runtime-tenants", "admin-status"],
    },
    tenantSchema: { max: options.tenantSchemaMax ?? 1 },
  };

  mkdirSync(join(dir, "bin"), { recursive: true });
  mkdirSync(join(dir, "node", "bin"), { recursive: true });
  mkdirSync(join(dir, "lib/node_modules/@nylorun/runtime/dist/host"), {
    recursive: true,
  });
  mkdirSync(join(dir, "lib/node_modules/@nylorun/runtime/dist/launcher"), {
    recursive: true,
  });

  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  const stub = HOST_STUB.replace("__VERSION__", options.version).replace(
    'process.env.NYLORUN_READY_DELAY_MS ?? "0"',
    `process.env.NYLORUN_READY_DELAY_MS ?? "${options.readyDelayMs ?? 0}"`,
  );
  await writeFile(join(dir, entry), stub);
  await writeFile(join(dir, launcher), LAUNCHER_STUB);

  const nodeName = platform === "win32" ? "node.exe" : "node";
  const nodeLink = join(dir, "node", "bin", nodeName);
  try {
    symlinkSync(process.execPath, nodeLink);
  } catch {
    writeFileSync(
      nodeLink,
      `#!/bin/sh\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 },
    );
  }
  chmodSync(nodeLink, 0o755);

  const posixShim = join(dir, "bin", "nylorun-runtime");
  writeFileSync(
    posixShim,
    `#!/bin/sh\nROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"\nexec "$ROOT/node/bin/node" "$ROOT/${launcher}" "$@"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "bin", "nylorun-runtime.cmd"),
    `@echo off\r\n"%~dp0..\\node\\bin\\node.exe" "%~dp0..\\${launcher.replace(/\//g, "\\")}" %*\r\n`,
  );

  return {
    dir,
    manifest,
    entry: join(dir, entry),
    launcher: join(dir, launcher),
  };
}

/** Tenants-era npm install layout (no manifest.json). */
export async function writeTenantsEraInstall(
  dir: string,
  version: string,
): Promise<void> {
  const pkgDir = join(dir, "node_modules", "@nylorun", "runtime");
  await mkdir(join(pkgDir, "dist", "core"), { recursive: true });
  await writeFile(join(pkgDir, "dist", "core", "main.js"), "export {};\n");
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@nylorun/runtime",
      version,
      type: "module",
      exports: { "./server": "./dist/core/main.js" },
    }),
  );
}
