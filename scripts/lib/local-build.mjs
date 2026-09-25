/**
 * Build a D§8.2 Runtime build layout for the current platform from the
 * workspace. Local mode copies Node from process.execPath (D8, G1).
 */
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { packWorkspacePackages } from "./workspace-host-install.mjs";
import { npm, readJson, root, writeJson } from "./repo.mjs";

// No darwin-x64: microsandbox ships no Intel macOS binary and GitHub-hosted
// Intel macOS runners end in Aug 2027.
export const RUNTIME_BUILD_PLATFORMS = [
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
];

export function currentPlatformArch(
  platform = process.platform,
  arch = process.arch,
) {
  const key = `${platform}-${arch}`;
  if (!RUNTIME_BUILD_PLATFORMS.includes(key))
    throw new Error(
      `platform_unsupported: Runtime builds are not published for ${key}.`,
    );
  return { platform, arch, key };
}

export function buildPackageName(platform, arch) {
  return `@nylorun/runtime-${platform}-${arch}`;
}

export function defaultBuildOut(platform, arch, repo = root) {
  return join(repo, ".tmp/runtime-builds", `${platform}-${arch}`);
}

function parseExportConstNumber(source, name) {
  const match = source.match(
    new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)\\s*;`),
  );
  if (!match) throw new Error(`Could not parse ${name} from source.`);
  return Number(match[1]);
}

async function readProtocol(repo = root) {
  try {
    const dist = join(repo, "core/dist/compatibility.js");
    const mod = await import(pathToFileURL(dist).href);
    return {
      protocol: {
        min: mod.HOST_PROTOCOL.min,
        max: mod.HOST_PROTOCOL.max,
        features: [...mod.HOST_PROTOCOL.features],
      },
      launcherProtocol: mod.LAUNCHER_PROTOCOL,
    };
  } catch {
    const source = await readFile(
      join(repo, "core/src/compatibility.ts"),
      "utf8",
    );
    const min = Number(source.match(/\bmin\s*:\s*(\d+)/)?.[1]);
    const max = Number(source.match(/\bmax\s*:\s*(\d+)/)?.[1]);
    const list = source.match(
      /export\s+const\s+PROTOCOL_FEATURES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
    );
    const features = list
      ? [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
      : [];
    return {
      protocol: { min, max, features },
      launcherProtocol: parseExportConstNumber(source, "LAUNCHER_PROTOCOL"),
    };
  }
}

async function readTenantSchemaMax(repo = root) {
  const source = await readFile(
    join(repo, "runtime/src/tenant/schema.ts"),
    "utf8",
  );
  return parseExportConstNumber(source, "TENANT_SCHEMA_VERSION");
}

export function posixLauncherShim(launcherRelative) {
  return `#!/bin/sh
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
exec "$ROOT/node/bin/node" "$ROOT/${launcherRelative}" "$@"
`;
}

export function windowsLauncherShim(launcherRelative) {
  const winPath = launcherRelative.replaceAll("/", "\\");
  return `@echo off\r
setlocal\r
set "ROOT=%~dp0.."\r
"%ROOT%\\node\\bin\\node.exe" "%ROOT%\\${winPath}" %*\r
`;
}

/**
 * Place a Node binary at build/node/bin/node[.exe] from process.execPath
 * (local mode) or from an extracted official distribution (release mode).
 *
 * Local mode copies by default: npm pack drops absolute symlinks, so a
 * registry tarball would otherwise lack node/bin/node (J CCR / G Wave 3).
 */
export async function installNodeBinary(
  buildDir,
  { sourcePath, windows, link = false },
) {
  const binDir = join(buildDir, "node", "bin");
  await mkdir(binDir, { recursive: true });
  const target = join(binDir, windows ? "node.exe" : "node");
  await rm(target, { force: true });
  if (link) {
    try {
      await symlink(sourcePath, target);
      return target;
    } catch {
      /* fall through to copy */
    }
  }
  await copyFile(sourcePath, target);
  if (!windows) await chmod(target, 0o755);
  return target;
}

/**
 * Ensure node/bin/node is a real file (not an absolute symlink) so npm pack
 * includes it. Safe to call on an already-copied binary.
 */
export async function materializeNodeBinary(
  buildDir,
  platform = process.platform,
) {
  const binDir = join(buildDir, "node", "bin");
  const target = join(binDir, platform === "win32" ? "node.exe" : "node");
  try {
    const stats = await lstat(target);
    if (!stats.isSymbolicLink()) {
      await access(target);
      return target;
    }
  } catch {
    /* missing — copy below */
  }
  await mkdir(binDir, { recursive: true });
  await rm(target, { force: true });
  await copyFile(process.execPath, target);
  if (platform !== "win32") await chmod(target, 0o755);
  return target;
}

export async function writeBuildShims(buildDir, launcherRelative) {
  const binDir = join(buildDir, "bin");
  await mkdir(binDir, { recursive: true });
  const posixPath = join(binDir, "nylorun-runtime");
  await writeFile(posixPath, posixLauncherShim(launcherRelative), "utf8");
  await chmod(posixPath, 0o755);
  const cmdPath = join(binDir, "nylorun-runtime.cmd");
  await writeFile(cmdPath, windowsLauncherShim(launcherRelative), "utf8");
  return { posixPath, cmdPath };
}

export async function writeBuildManifest(buildDir, manifest) {
  await writeJson(join(buildDir, "manifest.json"), manifest);
  return join(buildDir, "manifest.json");
}

/**
 * Install packed workspace runtime (+ deps) into buildDir/lib.
 */
export async function installRuntimeIntoBuild(buildDir, version, repo = root) {
  const packDir = join(buildDir, ".pack");
  const packed = await packWorkspacePackages(packDir, [
    "core",
    "harness",
    "runtime",
  ]);
  const lib = join(buildDir, "lib");
  await mkdir(lib, { recursive: true });
  await writeJson(join(lib, "package.json"), {
    name: `nylorun-runtime-build-${version}`,
    private: true,
    dependencies: {
      "@nylorun/runtime": version,
    },
  });
  await npm(
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      packed.core,
      packed.harness,
      packed.runtime,
    ],
    { cwd: lib, capture: true },
  );
  await rm(packDir, { recursive: true, force: true });
  const runtimeRoot = join(lib, "node_modules/@nylorun/runtime");
  const pkg = await readJson(join(runtimeRoot, "package.json"));
  if (pkg.version !== version) {
    pkg.version = version;
    await writeJson(join(runtimeRoot, "package.json"), pkg);
  }
  return runtimeRoot;
}

/**
 * Assemble a D§8.2 build directory.
 */
export async function assembleRuntimeBuild(options) {
  const {
    out,
    version,
    platform,
    arch,
    nodeVersion,
    nodeSourcePath,
    protocol,
    launcherProtocol = 1,
    tenantSchemaMax,
    windows = platform === "win32",
    repo = root,
  } = options;

  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  await installRuntimeIntoBuild(out, version, repo);
  await installNodeBinary(out, { sourcePath: nodeSourcePath, windows });

  const entry = "lib/node_modules/@nylorun/runtime/dist/host/main.js";
  const launcher = "lib/node_modules/@nylorun/runtime/dist/launcher/main.js";
  await writeBuildShims(out, launcher);

  const name = buildPackageName(platform, arch);
  const manifest = {
    format: 1,
    runtimeVersion: version,
    platform,
    arch,
    node: { version: nodeVersion },
    entry,
    launcher,
    launcherProtocol,
    protocol,
    tenantSchema: { max: tenantSchemaMax },
  };
  await writeBuildManifest(out, manifest);
  await writeJson(join(out, "package.json"), {
    name,
    version,
    description: `Nylorun Runtime build for ${platform}-${arch}`,
    license: "Apache-2.0",
    files: ["manifest.json", "bin", "node", "lib"],
    publishConfig: { access: "public", provenance: true },
  });

  return { dir: out, name, version, manifest };
}

/**
 * @param {{ out?: string, repo?: string, nodePath?: string }} [options]
 * @returns {Promise<{ dir: string, name: string, version: string }>}
 */
export async function localRuntimeBuild({
  out,
  repo = root,
  nodePath = process.execPath,
} = {}) {
  const { platform, arch } = currentPlatformArch();
  const runtime = await readJson(join(repo, "runtime/package.json"));
  const version = runtime.version;
  const destination = out ?? defaultBuildOut(platform, arch, repo);
  const { protocol, launcherProtocol } = await readProtocol(repo);
  const tenantSchemaMax = await readTenantSchemaMax(repo);

  const result = await assembleRuntimeBuild({
    out: destination,
    version,
    platform,
    arch,
    nodeVersion: process.versions.node,
    nodeSourcePath: nodePath,
    protocol,
    launcherProtocol,
    tenantSchemaMax,
    windows: platform === "win32",
    repo,
  });

  return { dir: result.dir, name: result.name, version: result.version };
}
