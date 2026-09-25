import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync } from "node:fs";

export interface SpawnHostInput {
  nodeBinary: string;
  entry: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
  detached: boolean;
  logPath?: string;
}

/**
 * Spawn the Host on the launcher's own Node (`process.execPath`). Detached
 * background Hosts get their own process group and survive after `up` exits.
 * stdout/stderr append to runtime.log when logPath is set.
 */
export function spawnHostProcess(input: SpawnHostInput): ChildProcess {
  const detached = input.detached;

  if (input.logPath) {
    const fd = openSync(input.logPath, "a", 0o600);
    try {
      const child = spawn(input.nodeBinary, [input.entry], {
        detached,
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
    stdio: ["ignore", "inherit", "inherit"],
    ...(detached ? { detached: true } : {}),
  });
}

/** Force-kill a Host process: its process group, else the process itself. */
export function forceKillHost(pid: number): void {
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
