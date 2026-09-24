import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LauncherError } from "./errors.js";
import type { HostPaths } from "./paths.js";

/**
 * Every tenants/<id>/tenant.json schemaVersion must be at most the target
 * build's tenantSchema.max.
 */
export function assertSchemaGuard(
  paths: HostPaths,
  tenantSchemaMax: number,
): void {
  let names: string[];
  try {
    names = readdirSync(paths.tenants);
  } catch {
    return;
  }
  for (const id of names) {
    if (id.startsWith(".")) continue;
    const tenantJson = join(paths.tenants, id, "tenant.json");
    if (!existsSync(tenantJson)) continue;
    let schemaVersion: number | undefined;
    try {
      const body = JSON.parse(readFileSync(tenantJson, "utf8")) as {
        schemaVersion?: number;
      };
      if (typeof body.schemaVersion === "number") {
        schemaVersion = body.schemaVersion;
      }
    } catch {
      continue;
    }
    if (schemaVersion !== undefined && schemaVersion > tenantSchemaMax) {
      throw new LauncherError(
        "host_schema_newer",
        `Tenant ${id} has schemaVersion ${schemaVersion}, which is newer than this build supports (max ${tenantSchemaMax}).`,
        "Upgrade to a Runtime build that supports this Tenant schema, or restore the Tenant from its migration snapshot.",
        { tenantId: id, schemaVersion, tenantSchemaMax },
      );
    }
  }
}
