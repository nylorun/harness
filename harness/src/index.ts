export { Harness, type HarnessOptions } from "./harness.js";
export { Agent } from "./agent.js";
export { AgentBuildError, HarnessInvariantError, HarnessLifecycleError } from "./errors.js";
export {
  defineAdapter,
  defineCapability,
  defineMiddleware,
  defineModel,
  defineTool,
} from "./definitions.js";

export type {
  BuildResult,
  Capability,
  CapabilitySetupContext,
  CapabilityContribution,
  CapabilityManifest,
} from "./types/capability.js";
export type {
  BoundModelId,
  ModelCandidate,
  ModelInvoker,
  ModelRegistryInput,
  ModelRequest,
  ModelToolCall,
} from "./types/model.js";
export type {
  AfterModelContext,
  BeforeModelContext,
  StepInput,
  StepMiddleware,
} from "./types/middleware.js";
export type {
  BuildDiagnostic,
  ContextItem,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ObserveEvent,
  Observer,
  Tripwire,
} from "./types/shared.js";
export type {
  AgentRunInput,
  InputCompletion,
  InputEvent,
  InputHandle,
  InputOptions,
  Session,
  SessionEvent,
  SessionOptions,
  SessionSnapshot,
  TranscriptEntry,
} from "./types/session.js";
export type {
  BoundToolDefinition,
  Interaction,
  PreflightOutcome,
  RequiredInteraction,
  SealedToolCall,
  SealedToolPlan,
  ToolAdapter,
  ToolContent,
  ToolDefinition,
  ToolExecutionResume,
  ToolObjectSchema,
  ToolOutcome,
  ToolResult,
} from "./types/tool.js";
