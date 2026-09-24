import type { HostConfigFile } from "./config.js";
import { tenantPaths } from "../tenant/paths.js";
import type { Logger, TenantConfig } from "../tenant/types.js";
import { tenantChildEnvironment } from "./environment.js";

/**
 * Builds a TenantConfig for `openTenantRuntime`.
 * Until Integration I1, returns defaults (no DB-backed seed); WS-A supplies
 * `readTenantConfig(db)` which the manager wires here.
 */
export function configForFactory(options: {
  hostRoot: string;
  hostConfig: HostConfigFile;
  logger: Logger;
  /** Allowlisted baseline from `baselineEnvironment` (built in `host/main.ts`). */
  baseline: Readonly<Record<string, string>>;
  mode?: TenantConfig["mode"];
}): (id: string) => TenantConfig {
  const { baseline } = options;
  return (id: string): TenantConfig => {
    const tenant = tenantPaths(options.hostRoot, id);
    return {
      tenantId: id,
      mode: options.mode ?? "shared",
      paths: tenant,
      sandbox: { backend: "auto" },
      model: { kind: "vault" },
      childEnv: tenantChildEnvironment(
        baseline,
        options.hostConfig,
        tenant,
      ),
      logger: {
        info: (message, fields) =>
          options.logger.info(message, { tenantId: id, ...fields }),
        warn: (message, fields) =>
          options.logger.warn(message, { tenantId: id, ...fields }),
        error: (message, fields) =>
          options.logger.error(message, { tenantId: id, ...fields }),
      },
    };
  };
}
