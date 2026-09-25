import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { LauncherError } from "./errors.js";

export interface ProcessLock {
  pid: number;
  startTime: string;
}

export interface LockOptions {
  /** Poll interval while waiting (ms). */
  pollMs?: number;
  /** Max wait for another holder (ms). */
  waitMs?: number;
}

function processStartTime(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat.slice(closeParen + 2).split(" ");
    return fields[19];
  } catch {
    return undefined;
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function readLock(path: string): ProcessLock | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ProcessLock;
    if (typeof value?.pid === "number" && typeof value.startTime === "string") {
      return value;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function lockIsLive(lock: ProcessLock): boolean {
  if (!processAlive(lock.pid)) return false;
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
        JSON.stringify({ pid: process.pid, startTime } satisfies ProcessLock),
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

/**
 * Hold a PID+start-identity lock. Stale when the holder process is gone.
 * Times out with `lock_timeout`.
 */
export async function withProcessLock<T>(
  path: string,
  waitMs: number,
  body: () => Promise<T>,
  options: LockOptions = {},
): Promise<T> {
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + waitMs;

  for (;;) {
    recoverStaleLock(path);
    if (tryAcquireLock(path)) {
      try {
        return await body();
      } finally {
        releaseLock(path);
      }
    }

    while (Date.now() < deadline) {
      const held = readLock(path);
      if (!held || !lockIsLive(held)) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    if (Date.now() >= deadline) {
      throw new LauncherError(
        "lock_timeout",
        `Timed out waiting for lock ${path}.`,
        "Retry after the other launcher process finishes, or remove a stale lock if no launcher is running.",
        { path, waitMs },
      );
    }
  }
}

export const LIFECYCLE_LOCK_WAIT_MS = 60_000;

export function readProcessLock(path: string): ProcessLock | undefined {
  return readLock(path);
}

export function lockFileExists(path: string): boolean {
  return existsSync(path);
}

/** Test helper: force-write a lock as if held by `pid` with optional startTime. */
export function writeProcessLockForTest(
  path: string,
  lock: ProcessLock,
): void {
  writeFileSync(path, JSON.stringify(lock), { mode: 0o600 });
}

export {
  processStartTime,
  recoverStaleLock,
  releaseLock,
  tryAcquireLock,
};
