import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  RuntimeBuildManifestSchema,
  type RuntimeBuildManifest,
} from "@nylorun/core/contracts";
import type { PlatformArch } from "./builds.js";
import { LauncherError } from "./errors.js";
import { extractTarball } from "./extract.js";
import { verifyIntegrity } from "./integrity.js";
import {
  INSTALL_LOCK_WAIT_MS,
  withProcessLock,
  type LockOptions,
} from "./locks.js";
import {
  ensureDirSync,
  installLockPath,
  versionDir,
  type HostPaths,
} from "./paths.js";
import type { InstallRecord, InstallResult, LauncherEvent } from "./protocol.js";

export type ProgressEmitter = (
  event: Extract<LauncherEvent, { type: "progress" }>,
) => void;

export interface InstallOptions {
  version: string;
  from?: string;
  registry: string;
  platform: PlatformArch["platform"];
  arch: PlatformArch["arch"];
  emit?: ProgressEmitter;
  lock?: LockOptions;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

function packageName(platform: string, arch: string): string {
  return `@nylorun/runtime-${platform}-${arch}`;
}

function nodeBinaryRelative(platform: string): string {
  // Matches scripts/lib/local-build.mjs installNodeBinary layout.
  return platform === "win32"
    ? join("node", "bin", "node.exe")
    : join("node", "bin", "node");
}

/**
 * Verify a build directory: manifest, platform, version, and required files.
 */
export function verifyBuild(
  dir: string,
  expected: {
    version: string;
    platform: PlatformArch["platform"];
    arch: PlatformArch["arch"];
  },
): RuntimeBuildManifest {
  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new LauncherError(
      "install_failed",
      `Build at ${dir} is missing manifest.json.`,
      "Install a Runtime build package, not a Tenants-era npm install directory.",
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new LauncherError(
      "install_failed",
      `Build manifest at ${manifestPath} is not valid JSON.`,
      "Re-download the Runtime build and retry.",
      { cause: String(error) },
    );
  }
  const parsed = RuntimeBuildManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new LauncherError(
      "install_failed",
      `Build manifest at ${manifestPath} does not match the Runtime build schema.`,
      "Install a build produced for this Runtime release.",
      { issues: parsed.error.issues },
    );
  }
  const manifest = parsed.data;
  if (manifest.runtimeVersion !== expected.version) {
    throw new LauncherError(
      "install_failed",
      `Build version is ${manifest.runtimeVersion}, expected ${expected.version}.`,
      "Install the requested version, or pass the version that matches the build.",
    );
  }
  if (
    manifest.platform !== expected.platform ||
    manifest.arch !== expected.arch
  ) {
    throw new LauncherError(
      "platform_unsupported",
      `Build is ${manifest.platform}-${manifest.arch}; this machine is ${expected.platform}-${expected.arch}.`,
      "Install the Runtime build that matches this operating system and CPU.",
    );
  }
  const entryPath = join(dir, manifest.entry);
  const launcherPath = join(dir, manifest.launcher);
  const nodePath = join(dir, nodeBinaryRelative(expected.platform));
  for (const [label, path] of [
    ["entry", entryPath],
    ["launcher", launcherPath],
    ["Node binary", nodePath],
  ] as const) {
    if (!existsSync(path)) {
      throw new LauncherError(
        "install_failed",
        `Build is missing ${label} at ${path}.`,
        "Re-download the Runtime build; the package may be incomplete.",
      );
    }
  }
  return manifest;
}

function isTenantsEraInstall(dir: string): boolean {
  if (!existsSync(dir)) return false;
  return !existsSync(join(dir, "manifest.json"));
}

function writeInstallRecord(dir: string, record: InstallRecord): void {
  writeFileSync(
    join(dir, "install.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function fetchRegistryMetadata(
  registry: string,
  name: string,
  version: string,
  fetchImpl: typeof fetch,
): Promise<{ tarball: string; integrity: string }> {
  const encoded = name.replace("/", "%2f");
  const url = `${registry.replace(/\/$/, "")}/${encoded}/${version}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
    });
  } catch (error) {
    throw new LauncherError(
      "install_failed",
      `Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`,
      "Check network access to NYLORUN_REGISTRY and retry.",
    );
  }
  if (!response.ok) {
    throw new LauncherError(
      "install_failed",
      `Registry returned ${response.status} for ${url}.`,
      "Confirm the version exists for this platform, or use --from with a local build.",
      { status: response.status },
    );
  }
  const body = (await response.json()) as {
    dist?: { tarball?: string; integrity?: string };
  };
  const tarball = body.dist?.tarball;
  const integrity = body.dist?.integrity;
  if (!tarball || !integrity) {
    throw new LauncherError(
      "install_failed",
      `Registry metadata for ${name}@${version} is missing dist.tarball or dist.integrity.`,
      "Use a registry that publishes npm package metadata for Runtime builds.",
    );
  }
  return { tarball, integrity };
}

async function downloadToFile(
  url: string,
  dest: string,
  fetchImpl: typeof fetch,
  emit?: ProgressEmitter,
): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url);
  } catch (error) {
    throw new LauncherError(
      "install_failed",
      `Failed to download ${url}: ${error instanceof Error ? error.message : String(error)}`,
      "Check network access and retry.",
    );
  }
  if (!response.ok || !response.body) {
    throw new LauncherError(
      "install_failed",
      `Download failed with status ${response.status}.`,
      "Retry the install, or use --from with a local build.",
      { status: response.status },
    );
  }
  const totalHeader = response.headers.get("content-length");
  const total = totalHeader ? Number(totalHeader) : undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.byteLength;
      emit?.({
        type: "progress",
        phase: "download",
        received,
        ...(total !== undefined && Number.isFinite(total) ? { total } : {}),
      });
    }
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  await writeFile(dest, buffer, { mode: 0o600 });
}

async function materializeFromPath(
  from: string,
  staging: string,
): Promise<{ integrity: string | null; source: "path" }> {
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  cpSync(from, staging, { recursive: true });
  return { integrity: null, source: "path" };
}

async function materializeFromRegistry(
  options: InstallOptions,
  staging: string,
): Promise<{ integrity: string; source: "registry" }> {
  const name = packageName(options.platform, options.arch);
  const fetchImpl = options.fetchImpl ?? fetch;
  options.emit?.({ type: "progress", phase: "download" });
  const meta = await fetchRegistryMetadata(
    options.registry,
    name,
    options.version,
    fetchImpl,
  );
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  const tarballPath = join(staging, "package.tgz");
  await downloadToFile(meta.tarball, tarballPath, fetchImpl, options.emit);
  options.emit?.({ type: "progress", phase: "verify" });
  await verifyIntegrity(tarballPath, meta.integrity);
  options.emit?.({ type: "progress", phase: "extract" });
  const extractDir = join(staging, ".extract");
  mkdirSync(extractDir, { recursive: true, mode: 0o700 });
  await extractTarball(tarballPath, extractDir);
  for (const entry of await readdir(extractDir)) {
    renameSync(join(extractDir, entry), join(staging, entry));
  }
  rmSync(extractDir, { recursive: true, force: true });
  rmSync(tarballPath, { force: true });
  return { integrity: meta.integrity, source: "registry" };
}

function reuseInstalled(
  paths: HostPaths,
  options: InstallOptions,
): InstallResult | undefined {
  const target = versionDir(paths, options.version);
  if (!existsSync(target) || isTenantsEraInstall(target)) return undefined;
  try {
    verifyBuild(target, {
      version: options.version,
      platform: options.platform,
      arch: options.arch,
    });
    return { version: options.version, path: target, installed: false };
  } catch {
    return undefined;
  }
}

/**
 * Install a Runtime build into `runtime/<version>/` (D§9.5).
 */
export async function install(
  paths: HostPaths,
  options: InstallOptions,
): Promise<InstallResult> {
  if (
    options.platform !== "darwin" &&
    options.platform !== "linux" &&
    options.platform !== "win32"
  ) {
    throw new LauncherError(
      "platform_unsupported",
      `Platform ${options.platform} is not supported.`,
      "Use macOS, Linux (glibc), or Windows x64.",
    );
  }
  if (options.arch !== "arm64" && options.arch !== "x64") {
    throw new LauncherError(
      "platform_unsupported",
      `Architecture ${options.arch} is not supported.`,
      "Use arm64 or x64.",
    );
  }

  ensureDirSync(paths.runtime);
  const existing = reuseInstalled(paths, options);
  if (existing) return existing;

  const lock = installLockPath(paths, options.version);
  return withProcessLock(
    lock,
    options.lock?.waitMs ?? INSTALL_LOCK_WAIT_MS,
    async () => {
      const again = reuseInstalled(paths, options);
      if (again) return again;

      options.emit?.({ type: "progress", phase: "install" });
      const staging = join(
        paths.runtime,
        `.tmp-${options.version}-${randomBytes(6).toString("hex")}`,
      );
      try {
        const material =
          options.from !== undefined
            ? await materializeFromPath(options.from, staging)
            : await materializeFromRegistry(options, staging);

        verifyBuild(staging, {
          version: options.version,
          platform: options.platform,
          arch: options.arch,
        });

        const record: InstallRecord = {
          format: 1,
          version: options.version,
          integrity: material.integrity,
          source: material.source,
          installedAt: new Date().toISOString(),
        };
        writeInstallRecord(staging, record);

        const target = versionDir(paths, options.version);
        if (existsSync(target)) {
          if (isTenantsEraInstall(target)) {
            rmSync(target, { recursive: true, force: true });
          } else {
            await rm(staging, { recursive: true, force: true });
            const winner = reuseInstalled(paths, options);
            if (winner) return winner;
          }
        }
        renameSync(staging, target);
        return {
          version: options.version,
          path: target,
          installed: true,
        };
      } catch (error) {
        try {
          rmSync(staging, { recursive: true, force: true });
        } catch {
          /* leave diagnostics */
        }
        throw error;
      }
    },
    options.lock,
  );
}

/** Read install.json when present. */
export async function readInstallRecord(
  versionDirectory: string,
): Promise<InstallRecord | undefined> {
  try {
    return JSON.parse(
      await readFile(join(versionDirectory, "install.json"), "utf8"),
    ) as InstallRecord;
  } catch {
    return undefined;
  }
}
