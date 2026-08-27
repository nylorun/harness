/**
 * Local development contract installed by @nylorun/create-agent.
 *
 * Generated projects expose this surface through their root nylo.local.ts file.
 * Studio consumes that project-local file; applications never need it in their
 * production dependency graph.
 */
export * from "./runtime/index.js";
export { __nyloBindAgent, Fetchable } from "./runtime/runtime/host.js";
export type { CorsOptions, FetchHandler, FetchableOptions } from "./runtime/runtime/fetchable.js";
export { startLocalRuntime } from "./runtime/runtime/host.js";
export type { LocalRuntimeHost } from "./runtime/runtime/host.js";
