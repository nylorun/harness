import { LAUNCHER_PROTOCOL } from "@nylorun/core/compatibility";
import { installedVersions, type PlatformArch } from "./builds.js";
import { readHostConfig } from "./host-config.js";
import { readHostState } from "./host-state.js";
import { processAlive } from "./locks.js";
import { hostUrl, type HostPaths } from "./paths.js";
import { portBindable, probeHostHealth } from "./probe.js";
import type { StatusResult } from "./protocol.js";

/**
 * Status with no lock and no mutation (D§9.3).
 */
export async function status(
  paths: HostPaths,
  current: PlatformArch,
): Promise<StatusResult> {
  const config = await readHostConfig(paths);
  const stateFile = await readHostState(paths);
  const installed = installedVersions(paths, current);
  const runtimeVersion =
    config && typeof config.runtimeVersion === "string"
      ? config.runtimeVersion
      : undefined;

  const base: StatusResult = {
    launcherProtocol: LAUNCHER_PROTOCOL,
    home: paths.root,
    state: "absent",
    installed,
    ...(runtimeVersion ? { runtimeVersion } : {}),
  };

  if (!config) {
    return base;
  }

  const url = hostUrl(config);
  const withConfig: StatusResult = {
    ...base,
    state: "stopped",
    url,
    hostId: config.hostId,
    ...(stateFile?.pid ? { pid: stateFile.pid } : {}),
    ...(stateFile?.version ? { version: stateFile.version } : {}),
  };

  const probe = await probeHostHealth(url);
  const ours =
    probe.health !== undefined &&
    (probe.health.hostId === undefined ||
      probe.health.hostId === config.hostId);

  if (probe.foreign) {
    return { ...withConfig, state: "foreign-port" };
  }
  if (probe.health && ours) {
    return {
      ...withConfig,
      state: "running",
      ...(probe.health.version ? { version: probe.health.version } : {}),
      ...(probe.health.hostId ? { hostId: probe.health.hostId } : {}),
      ...(probe.health.pid ? { pid: probe.health.pid } : {}),
    };
  }
  if (probe.health && !ours) {
    return {
      ...withConfig,
      state: "foreign-port",
      ...(probe.health.hostId ? { hostId: probe.health.hostId } : {}),
    };
  }
  if (stateFile && processAlive(stateFile.pid)) {
    return { ...withConfig, state: "unresponsive", pid: stateFile.pid };
  }
  if (!(await portBindable(config.host, config.port))) {
    return { ...withConfig, state: "foreign-port" };
  }
  return withConfig;
}
