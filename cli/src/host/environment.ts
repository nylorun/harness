import type { HostConfigFile } from "./root.js";

export interface HostProcessPaths {
  home: string;
  tmp: string;
  root: string;
}

/**
 * TENANTS-CCR: local copy of runtime host environment builders until
 * Integration I1 replaces this with the WS-C export from
 * `@nylorun/runtime` (`host/environment.ts`). Keep in sync with §12.
 */
// TENANTS-CCR: remove this file when WS-C export is wired at I1.
export function baselineEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key === "PATH" || key === "LANG" || key === "TZ" || key.startsWith("LC_")) {
      out[key] = value;
    }
  }
  return out;
}

export function hostProcessEnvironment(
  baseline: Readonly<Record<string, string | undefined>>,
  hostConfig: HostConfigFile,
  paths: HostProcessPaths,
): Record<string, string> {
  const env = baselineEnvironment(baseline);
  env.HOME = paths.home;
  env.TMPDIR = paths.tmp;
  env.NYLORUN_HOME = paths.root;
  env.HOST = hostConfig.host;
  env.PORT = String(hostConfig.port);
  // NODE_OPTIONS is never passed (§12).
  if (hostConfig.proxy?.httpsProxy) env.HTTPS_PROXY = hostConfig.proxy.httpsProxy;
  if (hostConfig.proxy?.noProxy) env.NO_PROXY = hostConfig.proxy.noProxy;
  if (hostConfig.proxy?.nodeExtraCaCerts) {
    env.NODE_EXTRA_CA_CERTS = hostConfig.proxy.nodeExtraCaCerts;
  }
  return env;
}
