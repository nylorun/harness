export { Agent, isModelIdentity, isPortableName } from "./agent.js";
export { buildAgent } from "./build.js";
export { nyloAgent } from "./plugin.js";
export { defineTool } from "./tool.js";
export { createFilesystemReader, validateAgent } from "./validate.js";
export type {
  AgentConfig,
  AgentOptions,
  BuildOptions,
  BuildResult,
  CapabilityManifest,
  DiagnosticPhase,
  FolderDiagnostic,
  FolderEntry,
  FolderReader,
  McpDeclaration,
  SkillDescriptor,
  ToolContext,
  ToolDefinition,
  ToolDescriptor,
  ValidateOptions,
  ValidationResult
} from "./types.js";

// The session loop. One implementation, imported by both the local host and the Agent Runtime —
// which is what makes local/hosted parity structural rather than a claim two codebases agree on.
export {
  createSession,
  fold,
  initialState,
  rehydrate,
  ProviderError,
  SESSION_EVENT_TYPES,
  SKILL_TOOL_NAME
} from "./session/index.js";
export type {
  ChatMessage,
  Clock,
  CreateSessionOptions,
  EventSink,
  ExitReason,
  HostSessionEventType,
  Json,
  JsonSchema,
  ProviderAdapter,
  ProviderCallEvidence,
  ProviderChunk,
  ProviderErrorCode,
  ProviderErrorOptions,
  ProviderRequest,
  ProviderUsage,
  Session,
  SessionDefinition,
  SessionEvent,
  SessionEventType,
  SessionLimits,
  SessionSafePoint,
  SessionSkill,
  SessionState,
  SessionStatus,
  SessionToolContext,
  ToolCall,
  ToolChunk,
  ToolRegistration,
  TranscriptEntry
} from "./session/index.js";

// Local execution: turning a built artifact into a session, and a catalog identity into a call.
export { openAgent } from "./runtime/open.js";
export type { AgentRun, EmbeddedAgent, OpenOptions, RunResult } from "./runtime/open.js";
export { OpenAICompatibleProvider } from "./runtime/openai-compatible.js";
export type { OpenAICompatibleProviderOptions, RetryPolicy } from "./runtime/openai-compatible.js";
export { OPENROUTER_VARIABLE, resolveModel } from "./runtime/model.js";
export type { ResolvedModel } from "./runtime/model.js";
export { resolveCredential } from "./runtime/credentials.js";
export type { CredentialSource, ResolvedCredential } from "./runtime/credentials.js";
