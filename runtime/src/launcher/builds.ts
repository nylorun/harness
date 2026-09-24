import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "@nylorun/core/compatibility";
import {
  RuntimeBuildManifestSchema,
  type RuntimeBuildManifest,
} from "@nylorun/core/contracts";
import type { HostPaths } from "./paths.js";

export type PlatformArch = {
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
};

export interface InstalledBuild {
  version: string;
  path: string;
  manifest: RuntimeBuildManifest;
  launcher: string;
}

function readManifest(dir: string): RuntimeBuildManifest | undefined {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const parsed = RuntimeBuildManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * List installed Runtime builds for this platform/arch.
 * Skips dot-directories and Tenants-era installs (no valid manifest).
 */
export function listInstalledBuilds(
  paths: HostPaths,
  current: PlatformArch,
): InstalledBuild[] {
  let names: string[];
  try {
    names = readdirSync(paths.runtime);
  } catch {
    return [];
  }
  const builds: InstalledBuild[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = join(paths.runtime, name);
    const manifest = readManifest(dir);
    if (!manifest) continue;
    if (
      manifest.platform !== current.platform ||
      manifest.arch !== current.arch
    ) {
      continue;
    }
    const launcherName =
      current.platform === "win32" ? "nylorun-runtime.cmd" : "nylorun-runtime";
    builds.push({
      version: manifest.runtimeVersion,
      path: dir,
      manifest,
      launcher: join(dir, "bin", launcherName),
    });
  }
  return builds;
}

/**
 * Newest installed build by SemVer (`compareVersions`), or undefined when none.
 */
export function newestBuild(
  paths: HostPaths,
  current: PlatformArch,
): InstalledBuild | undefined {
  const builds = listInstalledBuilds(paths, current);
  if (builds.length === 0) return undefined;
  builds.sort((a, b) => compareVersions(a.version, b.version));
  return builds[builds.length - 1];
}

export function installedVersions(
  paths: HostPaths,
  current: PlatformArch,
): string[] {
  return listInstalledBuilds(paths, current)
    .map((b) => b.version)
    .sort((a, b) => compareVersions(a, b));
}

export { readManifest };
