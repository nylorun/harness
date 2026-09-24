/**
 * Re-exports Host environment builders from `@nylorun/runtime` (Integration I1).
 * CLI spawn sets NYLORUN_HOME via `hostProcessEnvironment`.
 */
import {
  baselineEnvironment as runtimeBaseline,
  hostProcessEnvironment as runtimeHostProcess,
} from "@nylorun/runtime";
import type { HostConfigFile } from "./root.js";

export interface HostProcessPaths {
  home: string;
  tmp: string;
  root: string;
}

export function baselineEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  return runtimeBaseline(env);
}

export function hostProcessEnvironment(
  baseline: Readonly<Record<string, string | undefined>>,
  hostConfig: HostConfigFile,
  paths: HostProcessPaths,
): Record<string, string> {
  return runtimeHostProcess(baselineEnvironment(baseline), hostConfig, paths);
}
