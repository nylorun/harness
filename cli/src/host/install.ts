import { createRequire } from "node:module";
import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { CliError } from "../errors.js";
import { ensureDirSync, type HostPaths } from "./root.js";

const require = createRequire(import.meta.url);

export interface InstallLock {
  pid: number;
  startTime: string;
}

export type Installer = (input: {
  version: string;
  stagingDir: string;
  versionDir: string;
}) => Promise<void>;

export interface EnsureInstalledOptions {
  version?: string;
  installer?: Installer;
  /** Poll interval while waiting on another installer's lock. */
  pollMs?: number;
  /** Max wait for a concurrent install (ms). */
  waitMs?: number;
}

/** Exact pinned version from the CLI's own `@nylorun/runtime` dependency. */
export function cliRuntimePackageVersion(): string {
  try {
    return require("@nylorun/runtime/package.json").version as string;
  } catch {
    /* fall through */
  }
  try {
    let directory = dirname(require.resolve("@nylorun/runtime/server"));
    for (let depth = 0; depth < 5; depth += 1) {
      const candidate = join(directory, "package.json");
      if (existsSync(candidate)) {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "@nylorun/runtime" && pkg.version) return pkg.version;
      }
      directory = dirname(directory);
    }
  } catch {
    /* reported elsewhere */
  }
  throw new CliError(
    "This CLI cannot resolve its @nylorun/runtime dependency version.",
    1,
  );
}


function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat.slice(closeParen + 2).split(" ");
    // Field 22 in /proc/pid/stat is starttime (1-indexed; after comm this is index 19).
    return fields[19];
  } catch {
    return undefined;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function lockPath(paths: HostPaths, version: string): string {
  return join(paths.runtime, `.install-${version}.lock`);
}

function readLock(path: string): InstallLock | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as InstallLock;
    if (typeof value?.pid === "number" && typeof value.startTime === "string") {
      return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function lockIsLive(lock: InstallLock): boolean {
  if (!alive(lock.pid)) return false;
  const start = processStartTime(lock.pid);
  // When /proc is unavailable, treat a live PID as holding the lock.
  if (start === undefined) return true;
  return start === lock.startTime;
}

function tryAcquireLock(path: string): boolean {
  try {
    const fd = openSync(path, "wx", 0o600);
    try {
      const startTime = processStartTime(process.pid) ?? String(Date.now());
      writeFileSync(
        fd,
        JSON.stringify({ pid: process.pid, startTime } satisfies InstallLock),
      );
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

function releaseLock(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    /* gone */
  }
}

function recoverStaleLock(path: string): void {
  const lock = readLock(path);
  if (!lock || lockIsLive(lock)) return;
  releaseLock(path);
}

export function versionDir(paths: HostPaths, version: string): string {
  return join(paths.runtime, version);
}

export function serverEntry(versionDirectory: string): string {
  return join(
    versionDirectory,
    "node_modules",
    "@nylorun",
    "runtime",
    "dist",
    "core",
    "main.js",
  );
}

/**
 * Verify an installed version directory: package name, version and `./server`
 * export resolve.
 */
export function verifyInstalled(
  versionDirectory: string,
  expectedVersion: string,
): { entry: string; version: string } {
  const pkgPath = join(
    versionDirectory,
    "node_modules",
    "@nylorun",
    "runtime",
    "package.json",
  );
  if (!existsSync(pkgPath)) {
    throw new CliError(
      `Installed Runtime at ${versionDirectory} is missing @nylorun/runtime.`,
      1,
    );
  }
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    name?: string;
    version?: string;
    exports?: Record<string, unknown>;
  };
  if (pkg.name !== "@nylorun/runtime") {
    throw new CliError(
      `Installed package name is ${pkg.name ?? "unknown"}, expected @nylorun/runtime.`,
      1,
    );
  }
  if (pkg.version !== expectedVersion) {
    throw new CliError(
      `Installed Runtime version is ${pkg.version ?? "unknown"}, expected ${expectedVersion}.`,
      1,
    );
  }
  if (!pkg.exports || !("./server" in pkg.exports)) {
    throw new CliError(
      `Installed @nylorun/runtime@${expectedVersion} does not export ./server.`,
      1,
    );
  }
  // Prefer the package's declared server entry via createRequire from the install.
  try {
    const localRequire = createRequire(pkgPath);
    const entry = localRequire.resolve("@nylorun/runtime/server");
    return { entry, version: expectedVersion };
  } catch {
    const entry = serverEntry(versionDirectory);
    if (!existsSync(entry)) {
      throw new CliError(
        `Installed @nylorun/runtime@${expectedVersion} has no resolvable ./server entry.`,
        1,
      );
    }
    return { entry, version: expectedVersion };
  }
}

const defaultInstaller: Installer = async ({ version, stagingDir }) => {
  await mkdir(stagingDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(stagingDir, "package.json"),
    JSON.stringify({
      name: `nylorun-runtime-install-${version}`,
      private: true,
      dependencies: { "@nylorun/runtime": version },
    }),
  );
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      "npm",
      [
        "install",
        "--omit=dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        `@nylorun/runtime@${version}`,
      ],
      {
        cwd: stagingDir,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, npm_config_update_notifier: "false" },
      },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new CliError(
            `npm install @nylorun/runtime@${version} failed (${code}).${stderr ? `\n${stderr.trim()}` : ""}`,
            1,
          ),
        );
    });
  });
};

/**
 * Ensure `runtime/<version>/` holds a verified install of the CLI's pinned
 * Runtime. Concurrent callers wait and reuse. Failure leaves any running Host
 * and installed versions untouched.
 */
export async function ensureInstalled(
  paths: HostPaths,
  options: EnsureInstalledOptions = {},
): Promise<{ versionDir: string; entry: string; version: string }> {
  const version = options.version ?? cliRuntimePackageVersion();
  const target = versionDir(paths, version);
  ensureDirSync(paths.runtime);

  const reuse = (): { versionDir: string; entry: string; version: string } | undefined => {
    if (!existsSync(target)) return undefined;
    try {
      const verified = verifyInstalled(target, version);
      return { versionDir: target, ...verified };
    } catch {
      return undefined;
    }
  };

  const existing = reuse();
  if (existing) return existing;

  const lock = lockPath(paths, version);
  const installer = options.installer ?? defaultInstaller;
  const pollMs = options.pollMs ?? 100;
  const waitMs = options.waitMs ?? 120_000;
  const deadline = Date.now() + waitMs;

  for (;;) {
    recoverStaleLock(lock);
    if (tryAcquireLock(lock)) {
      try {
        const again = reuse();
        if (again) return again;

        const staging = join(
          paths.runtime,
          `.tmp-${version}-${randomBytes(6).toString("hex")}`,
        );
        try {
          await installer({ version, stagingDir: staging, versionDir: target });
          verifyInstalled(staging, version);
          // Atomic rename: only after verification.
          if (existsSync(target)) {
            // Another verified install appeared; prefer it and drop staging.
            await rm(staging, { recursive: true, force: true });
            const winner = reuse();
            if (winner) return winner;
          }
          renameSync(staging, target);
          return { versionDir: target, ...verifyInstalled(target, version) };
        } catch (error) {
          try {
            rmSync(staging, { recursive: true, force: true });
          } catch {
            /* leave diagnostics if rm fails */
          }
          // Do not touch target or any other installed version.
          throw error;
        }
      } finally {
        releaseLock(lock);
      }
    }

    // Wait for the other installer.
    while (Date.now() < deadline) {
      const ready = reuse();
      if (ready) return ready;
      const held = readLock(lock);
      if (!held || !lockIsLive(held)) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (Date.now() >= deadline) {
      throw new CliError(
        `Timed out waiting for another process to install @nylorun/runtime@${version}.`,
        1,
      );
    }
  }
}

/** Test helper: write a fake verified install tree without npm. */
export async function writeFakeInstall(
  paths: HostPaths,
  version: string,
  options: { withServerExport?: boolean } = {},
): Promise<{ versionDir: string; entry: string }> {
  const target = versionDir(paths, version);
  const pkgDir = join(target, "node_modules", "@nylorun", "runtime");
  await mkdir(join(pkgDir, "dist", "core"), { recursive: true });
  const entry = join(pkgDir, "dist", "core", "main.js");
  await writeFile(
    entry,
    `process.send?.({ type: "ready" });\nsetInterval(() => {}, 1 << 30);\n`,
  );
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@nylorun/runtime",
      version,
      type: "module",
      exports: {
        "./server":
          options.withServerExport === false
            ? undefined
            : "./dist/core/main.js",
        "./package.json": "./package.json",
      },
    }),
  );
  // Clean undefined export key when withServerExport is false.
  if (options.withServerExport === false) {
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@nylorun/runtime",
        version,
        type: "module",
        exports: { "./package.json": "./package.json" },
      }),
    );
  }
  return { versionDir: target, entry };
}

export async function readInstallLock(
  paths: HostPaths,
  version: string,
): Promise<InstallLock | undefined> {
  try {
    return JSON.parse(await readFile(lockPath(paths, version), "utf8")) as InstallLock;
  } catch {
    return undefined;
  }
}
