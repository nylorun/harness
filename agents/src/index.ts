// Definition authoring and wire contracts are the only harness runtime imports.
export {
  Agent,
  AgentBuilder,
  AgentBuildError,
  AgentLifecycleError,
  capability,
  tool,
  defineSchema,
  ToolError,
} from "@nylorun/harness/define";
export type {
  AgentOptions,
  AgentManifest,
  BuiltAgent,
  ToolDefinition,
  ToolExecutionContext,
  ToolOutcome,
  Patch,
  Decision,
  JsonValue,
  JsonObject,
} from "@nylorun/harness/define";
export type {
  LiveEvent,
  SessionCommand,
  Action,
  ActionOutcome,
} from "@nylorun/harness/contracts";
export { AgentsClient, SessionClient, createClient } from "./client.js";
export type { AgentSource, SessionView, CommandOptions } from "./client.js";
export { connectAgents } from "./executor.js";
export type { ConnectOptions, AgentConnection } from "./executor.js";
export { RuntimeError } from "./http.js";
export type { Destination } from "./http.js";
