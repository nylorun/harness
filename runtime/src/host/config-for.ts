import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { HostConfigFile } from "./config.js";
import { tenantPaths } from "../tenant/paths.js";
import { readTenantConfig } from "../tenant/schema.js";
import type { Logger, TenantConfig } from "../tenant/types.js";
import { tenantChildEnvironment } from "./environment.js";

/**
 * Builds a TenantConfig for `openTenantRuntime`.
 * Reads seeded sandbox backend from the Tenant database when present (I1).
 */
export function configForFactory(options: {
  hostRoot: string;
  hostConfig: HostConfigFile;
  logger: Logger;
  /** Allowlisted baseline from `baselineEnvironment` (built in `host/main.ts`). */
  baseline: Readonly<Record<string, string>>;
  mode?: TenantConfig["mode"];
  /** Override model; default vault. Fixture/scripted require ephemeral/test mode. */
  model?: TenantConfig["model"];
}): (id: string) => TenantConfig {
  const { baseline } = options;
  return (id: string): TenantConfig => {
    const tenant = tenantPaths(options.hostRoot, id);
    let sandboxBackend: TenantConfig["sandbox"]["backend"] = "auto";
    if (existsSync(tenant.database)) {
      try {
        const db = new DatabaseSync(tenant.database, { readOnly: true });
        try {
          const seeded = readTenantConfig(db).sandboxBackend;
          if (seeded) sandboxBackend = seeded;
        } finally {
          db.close();
        }
      } catch {
        /* unreadable — keep default */
      }
    }
    return {
      tenantId: id,
      mode: options.mode ?? "shared",
      paths: tenant,
      sandbox: { backend: sandboxBackend },
      model: options.model ?? { kind: "vault" },
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
