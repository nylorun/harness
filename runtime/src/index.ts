export {
  openTenantRuntime,
  type TenantOpenHooks,
} from "./tenant/runtime.js";
export type {
  TenantConfig,
  TenantHandle,
  TenantPaths,
  Logger,
  OpenTenantRuntime,
} from "./tenant/types.js";
export { scriptedModel, gatewayModel, type ModelProvider } from "./core/provider.js";
export type { RuntimeAgent } from "./contracts.js";
export {
  IMAGE_MEDIA_TYPES,
  MAX_IMAGE_BYTES,
  decodeImageBase64,
  validateImageBytes,
} from "./media.js";
export type { RuntimeModelAdapter } from "./contracts.js";

// TENANTS-CCR: temporary re-exports until A2 / dependents migrate
export {
  createRuntime,
  startRuntime,
  type RuntimeOptions,
  type CoreRuntime,
} from "./core/runtime.js";
