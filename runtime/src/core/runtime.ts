export {
  openTenantRuntime,
  TenantRuntime,
  type TenantOpenHooks,
} from "../tenant/runtime.js";
export { scriptedModel, gatewayModel, type ModelProvider } from "./provider.js";

// TENANTS-CCR: legacy names removed in A2 (startEphemeralRuntime). Kept as aliases
// so package `./core` export and external scripts compile during Wave 1.
import { openTenantRuntime as open } from "../tenant/runtime.js";
import type { TenantHandle } from "../tenant/types.js";

/** @deprecated Use openTenantRuntime / startTestTenant (A1). */
export type RuntimeOptions = never;
/** @deprecated Use TenantHandle. */
export type CoreRuntime = TenantHandle;
/** @deprecated */
export function createRuntime(_options: unknown): never {
  throw new Error(
    "createRuntime was removed; use openTenantRuntime or startTestTenant",
  );
}
/** @deprecated */
export async function startRuntime(_options: unknown): Promise<never> {
  throw new Error(
    "startRuntime was removed; use startTestTenant or startEphemeralRuntime",
  );
}
void open;
