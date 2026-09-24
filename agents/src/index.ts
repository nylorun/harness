// Definition authoring and wire contracts are the only harness runtime imports.
export {
  hashManifest,
  PROTOCOL_VERSION,
  PROTOCOL_FEATURES,
  HOST_PROTOCOL,
  DEFINITION_SCHEMA_VERSION,
  TENANT_HEADER,
  PROTOCOL_HEADER,
  TENANT_ID_PATTERN,
  isTenantId,
  newTenantId,
  newPrincipalId,
  checkCompatibility,
  compareVersions,
  ERROR_CODES,
} from "@nylorun/core/compatibility";
export type {
  ProtocolFeature,
  ProtocolRange,
  Compatibility,
  ErrorCode,
} from "@nylorun/core/compatibility";
export {
  Agent,
  AgentBuilder,
  AgentBuildError,
  AgentLifecycleError,
  capability,
  tool,
  defineSchema,
  ToolError,
} from "@nylorun/core/define";
export type {
  AgentOptions,
  AgentManifest,
  BuiltAgent,
  ToolDefinition,
  ToolExecutionContext,
  ToolOutcome,
  Patch,
  Decision,
  TurnDecision,
  HookScope,
  BeforeHook,
  AfterHook,
  JsonValue,
  JsonObject,
} from "@nylorun/core/define";
export type {
  LiveEvent,
  SessionCommand,
  Action,
  ActionOutcome,
  CredentialInfo,
  CredentialSelection,
  VaultInfo,
} from "@nylorun/core/contracts";
export { AgentsClient, SessionClient, createClient } from "./client.js";
export type { AgentSource, SessionView, CommandOptions } from "./client.js";
export { connectAgents } from "./executor.js";
export type { ConnectOptions, AgentConnection } from "./executor.js";
export { resolveConnection } from "./connection.js";
export type { ResolvedConnection } from "./connection.js";
export { RuntimeError, IncompatibleRuntimeError } from "./http.js";
export type { Destination, IncompatibleReason } from "./http.js";
export { plugin } from "./plugins/plugin.js";
export type { PluginCapability } from "./plugins/plugin.js";
export { loadPlugin, PluginError } from "./plugins/load.js";
export type { LoadedPlugin, PluginDiagnostic } from "./plugins/load.js";
export { prepareStdioLaunch, expandPluginPlaceholders } from "./plugins/launch.js";
export type { StdioLaunch } from "./plugins/launch.js";
export {
  skills,
  loadSkillsFromDirectory,
  resolveSkillsRoot,
  parseSkill,
  SkillsError,
  formatSkillCatalog,
  SKILLS_USAGE,
} from "./skills/index.js";
export type {
  SkillsCapability,
  SkillsOptions,
  SkillDiagnostic,
} from "./skills/index.js";
export { mcp, McpError } from "./mcp/index.js";
export type { McpCapability, McpOptions } from "./mcp/index.js";
export { sandbox, SandboxError } from "./sandbox/index.js";
export type {
  SandboxCapability,
  SandboxCapabilityOptions,
  SandboxOptions,
} from "./sandbox/index.js";
