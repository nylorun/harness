import type { TenantConfig } from "../../src/tenant/types.js";

/**
 * Wave 0 signature stub. WS-A implements against `openTenantRuntime`.
 * Other workstreams may import this module; do not call until A1 lands.
 */
export async function startTestTenant(
  _options?: Partial<TenantConfig> & {
    executors?: readonly unknown[];
  },
): Promise<{
  url: string;
  tenantId: string;
  applicationKey: string;
  adminKey: string;
  headers(key?: string): Record<string, string>;
  root: string;
  close(): Promise<void>;
}> {
  throw new Error("TENANTS-W0: startTestTenant is implemented by WS-A");
}
