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
}

const HOST_STUB = `import { createServer } from "node:http";
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? "0");
const hostId = process.env.NYLORUN_HOST_ID ?? "host_0123456789abcdefghjkmnpq";
const version = process.env.NYLORUN_RUNTIME_VERSION ?? "0.0.0-test";
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      service: "nylorun-runtime",
      version,
      hostId,
      pid: process.pid,
      protocol: { min: 2, max: 2, features: ["runtime-tenants", "admin-status"] },
    }));
    return;
  }
  if (url.pathname === "/ready") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ready", service: "nylorun-runtime" }));
    return;
  }
  res.writeHead(404);
  res.end();
});
server.listen(port, host, () => {
  const address = server.address();
  if (address && typeof address !== "string") {
    process.stdout.write(JSON.stringify({ type: "ready", port: address.port }) + "\\n");
  }
});
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
  const platform = options.platform ?? (process.platform as PlatformArch["platform"]);
  const arch = options.arch ?? (process.arch as PlatformArch["arch"]);
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const entry = "lib/node_modules/@nylorun/runtime/dist/host/main.js";
  const launcher = "lib/node_modules/@nylorun/runtime/dist/launcher/main.js";

  const manifest: RuntimeBuildManifest = {
    format: 1,
    runtimeVersion: options.version,
    platform: platform === "darwin" || platform === "linux" || platform === "win32"
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

  await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(dir, entry), HOST_STUB);
  await writeFile(join(dir, launcher), LAUNCHER_STUB);

  const nodeLink = join(dir, "node", "bin", "node");
  try {
    symlinkSync(process.execPath, nodeLink);
  } catch {
    // Fall back to a tiny wrapper script when symlink is unavailable.
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
    `@echo off\r\n"%~dp0..\\node\\bin\\node" "%~dp0..\\${launcher.replace(/\//g, "\\")}" %*\r\n`,
  );

  return { dir, manifest, entry: join(dir, entry), launcher: join(dir, launcher) };
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
