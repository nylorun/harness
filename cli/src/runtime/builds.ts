import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions } from "@nylorun/agents";

export type PlatformArch = {
  platform: "darwin" | "linux" | "win32";
  arch: "arm64" | "x64";
};

export interface InstalledBuild {
  version: string;
  path: string;
  launcher: string;
}

export function currentPlatformArch(): PlatformArch {
  const platform =
    process.platform === "darwin" ||
    process.platform === "linux" ||
    process.platform === "win32"
      ? process.platform
      : "linux";
  const arch =
    process.arch === "arm64" || process.arch === "x64" ? process.arch : "x64";
  return { platform, arch };
}

function readManifest(
  dir: string,
): { runtimeVersion: string; platform: string; arch: string } | undefined {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      runtimeVersion?: unknown;
      platform?: unknown;
      arch?: unknown;
    };
    if (
      typeof raw.runtimeVersion !== "string" ||
      typeof raw.platform !== "string" ||
      typeof raw.arch !== "string"
    ) {
      return undefined;
    }
    return {
      runtimeVersion: raw.runtimeVersion,
      platform: raw.platform,
      arch: raw.arch,
    };
  } catch {
    return undefined;
  }
}

/**
 * Newest installed Runtime build for this platform (D§9.1), or undefined.
 * Skips dot-directories and Tenants-era installs (no valid manifest).
 */
export function newestBuild(
  home: string,
  current: PlatformArch = currentPlatformArch(),
): InstalledBuild | undefined {
  const runtimeRoot = join(home, "runtime");
  let names: string[];
  try {
    names = readdirSync(runtimeRoot);
  } catch {
    return undefined;
  }
  const builds: InstalledBuild[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = join(runtimeRoot, name);
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
      launcher: join(dir, "bin", launcherName),
    });
  }
  if (builds.length === 0) return undefined;
  builds.sort((a, b) => compareVersions(a.version, b.version));
  return builds[builds.length - 1];
}

export function buildPackageName(current: PlatformArch = currentPlatformArch()): string {
  return `@nylorun/runtime-${current.platform}-${current.arch}`;
}
