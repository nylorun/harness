import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface SpawnHostInput {
  nodeBinary: string;
  entry: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  detached: boolean;
  logPath?: string;
  platform?: NodeJS.Platform;
}

/**
 * Spawn the Host on the launcher's own Node (`process.execPath`). Detached background Hosts survive after
 * `up` exits (including Windows — without detached the Host dies with the
 * launcher parent and createTenant sees ECONNREFUSED). stdout/stderr append to
 * runtime.log when logPath is set.
 */
export function spawnHostProcess(input: SpawnHostInput): ChildProcess {
  const detached = input.detached;

  if (input.logPath) {
    const fd = openSync(input.logPath, "a", 0o600);
    try {
      const child = spawn(input.nodeBinary, [input.entry], {
        detached,
        windowsHide: true,
        cwd: input.cwd,
        env: input.environment,
        stdio: ["ignore", fd, fd],
      });
      child.once("exit", () => {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      });
      return child;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }
  return spawn(input.nodeBinary, [input.entry], {
    cwd: input.cwd,
    env: input.environment,
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"],
    ...(detached ? { detached: true } : {}),
  });
}

/**
 * Force-kill a Host process. SIGKILL / process group on POSIX; taskkill on Windows.
 * Exported for Windows-path unit coverage (E14).
 */
export function forceKillHost(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    try {
      const child = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {
        try {
          process.kill(pid);
        } catch {
          /* gone */
        }
      });
    } catch {
      try {
        process.kill(pid);
      } catch {
        /* gone */
      }
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
}
