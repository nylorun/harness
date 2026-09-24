import type { DatabaseSync } from "node:sqlite";

/** First Tenant schema version (D4). Implemented by WS-A. */
export const TENANT_SCHEMA_VERSION = 1;

export function schemaVersionOf(_db: DatabaseSync): number {
  throw new Error("TENANTS-W0: schemaVersionOf is implemented by WS-A");
}

export function migrateTenantDatabase(
  _db: DatabaseSync,
): { from: number; to: number } {
  throw new Error("TENANTS-W0: migrateTenantDatabase is implemented by WS-A");
}
