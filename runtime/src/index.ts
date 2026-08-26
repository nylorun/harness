export { Agent, AgentSpec, Run, isModelIdentity, isPortableName } from "./agent.js";
export { AUTHORING_REFERENCE } from "./contract-reference.js";
export { buildAgent, watchAgent } from "./build.js";
export type { AgentBuildWatcher } from "./build.js";
export { nyloAgent } from "./plugin.js";
export { tool } from "./tool.js";
export { createFilesystemReader, validateAgent } from "./validate.js";
export type {
  AgentConfig,
  AgentOptions,
  AgentSpecOptions,
  RunOptions,
  BuildOptions,
  BuildResult,
  CapabilityManifest,
  DiagnosticPhase,
  FolderDiagnostic,
  FolderEntry,
  FolderReader,
  HarnessFactory,
  McpDeclaration,
  NylorunAgent,
  SkillDescriptor,
  ToolContext,
  ToolDefinition,
  ToolDescriptor,
  ValidateOptions,
  ValidationResult
} from "./types.js";
export { ModelGatewayError } from "./runtime/contracts.js";
export type {
  ChatMessage,
  Json,
  ModelGatewayAdapter,
  ModelGatewayCallEvidence,
  ModelGatewayChunk,
  ModelGatewayErrorCode,
  ModelGatewayErrorOptions,
  ModelGatewayRequest,
  ModelGatewayUsage,
  RuntimeSessionState,
  RuntimeSessionStatus,
  WireSessionEvent
} from "./runtime/contracts.js";
export type { InputEvent, Session, SessionEvent, SessionSnapshot } from "@nylorun/harness";

// Local execution. A built module exports its runtime handle as `agent` and its fetch-compatible
// hosted door as default; `__nyloBindAgent` is what the build calls and is not builder-facing.
export { __nyloBindAgent, __nyloUnboundAgent } from "./runtime/bind.js";
export type {
  AgentReadiness,
  AgentRun,
  AgentSessions,
  BuiltAgent,
  RuntimeOptions,
  RunResult,
  StartOptions
} from "./runtime/bind.js";
export { Fetchable } from "./runtime/fetchable.js";
export type { CorsOptions, FetchableOptions, FetchHandler } from "./runtime/fetchable.js";
export { createMemorySessionStore } from "./runtime/session-store.js";
export type { LiveSession, SessionRecord, SessionStore } from "./runtime/session-store.js";
export { createFileRecorder, redactRecord, RECORDS_DIRECTORY } from "./runtime/record-store.js";
export type {
  FileRecorderOptions,
  RecorderContext,
  RecordSummary,
  RecordTerminal,
  RecordWriter,
  SessionRecorder
} from "./runtime/record-store.js";
export { createAuthoringArchive, EXCLUDED as ARCHIVE_EXCLUSIONS } from "./publish/archive.js";
export type { Archive, ArchiveEntry } from "./publish/archive.js";
export { checkPublish } from "./publish/check.js";
export type { PublishCheck } from "./publish/check.js";
export { OpenAICompatibleModelGatewayAdapter } from "./runtime/openai-compatible.js";
export type { OpenAICompatibleModelGatewayAdapterOptions, RetryPolicy } from "./runtime/openai-compatible.js";
export {
  MODEL_GATEWAY_ACCESS_MODE_VARIABLE,
  MODEL_GATEWAY_API_KEY_VARIABLE,
  MODEL_GATEWAY_PROTOCOL_VARIABLE,
  MODEL_GATEWAY_PROTOCOLS,
  MODEL_GATEWAY_URL_VARIABLE,
  OPENROUTER_VARIABLE,
  resolveModel
} from "./runtime/model.js";
export type { ModelAccessMode, ModelConnectionCapabilities, ModelGatewayProtocol, ResolvedModel } from "./runtime/model.js";
export { resolveCredential } from "./runtime/credentials.js";
export type { CredentialSource, ResolvedCredential } from "./runtime/credentials.js";
