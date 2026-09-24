import { createServer } from "node:net";
import { LauncherError } from "./errors.js";
import {
  newHostId,
  readHostConfig,
  writeHostConfig,
  type HostConfigFile,
} from "./host-config.js";
import { hostUrl, type HostPaths } from "./paths.js";
import { portBindable, probeHostHealth } from "./probe.js";
import { ensureHostLayout } from "./paths.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

export interface EnsureHostConfigOptions {
  /** Explicit `--port`; collision fails (strict). `0` means pick a free port. */
  port?: number;
  host?: string;
}

async function findFreeLoopbackPort(host: string): Promise<number> {
  const server = createServer();
  return await new Promise<number>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a free loopback port."));
        return;
      }
      const { port } = address;
      server.close(() => resolvePromise(port));
    });
  });
}

/**
 * Load or create host.json. On first setup prefer 8787; when taken, pick a free
 * loopback port. Explicit `--port` is strict (except `0` = free port).
 */
export async function ensureHostConfig(
  paths: HostPaths,
  options: EnsureHostConfigOptions = {},
): Promise<{ config: HostConfigFile; created: boolean; portSelected: boolean }> {
  await ensureHostLayout(paths);
  const existing = await readHostConfig(paths);
  if (existing) {
    if (options.port !== undefined && options.port !== 0 && options.port !== existing.port) {
      const updated: HostConfigFile = {
        ...existing,
        format: 1,
        port: options.port,
      };
      if (!(await portBindable(updated.host, updated.port))) {
        const probe = await probeHostHealth(hostUrl(updated));
        if (!probe.health || probe.health.hostId !== updated.hostId) {
          throw new LauncherError(
            "foreign_port",
            `Port ${updated.port} on ${updated.host} is in use by another process.`,
            'Choose a free port with "nylorun-runtime up --port <n>".',
          );
        }
      }
      await writeHostConfig(paths, updated);
      return { config: updated, created: false, portSelected: false };
    }
    return {
      config: { ...existing, format: 1 },
      created: false,
      portSelected: false,
    };
  }

  const host = options.host ?? DEFAULT_HOST;
  let port = options.port === 0 ? await findFreeLoopbackPort(host) : (options.port ?? DEFAULT_PORT);
  let portSelected = options.port === 0;

  if (options.port !== undefined && options.port !== 0) {
    if (!(await portBindable(host, port))) {
      throw new LauncherError(
        "foreign_port",
        `Port ${port} on ${host} is in use by another process.`,
        'Choose a free port with "nylorun-runtime up --port <n>".',
      );
    }
  } else if (options.port === undefined) {
    if (!(await portBindable(host, port))) {
      const probe = await probeHostHealth(hostUrl({ host, port }));
      if (probe.foreign || probe.health || !(await portBindable(host, port))) {
        port = await findFreeLoopbackPort(host);
        portSelected = true;
      }
    }
  }

  const config: HostConfigFile = {
    format: 1,
    hostId: newHostId(),
    host,
    port,
  };
  await writeHostConfig(paths, config);
  return { config, created: true, portSelected };
}
