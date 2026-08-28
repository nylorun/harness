export { Agent, AgentBuilder, AgentBuildError, AgentLifecycleError } from "./build/builder.js";
export { HarnessError, isHarnessError } from "./errors.js";
export type { HarnessErrorCode, HarnessErrorDetails, HarnessErrorOptions } from "./errors.js";
export { BuiltAgent } from "./build/agent.js";
export { adapter, middleware, model, tool } from "./build/helpers.js";

export type { AgentManifest } from "./types/manifest.js";
export type {
  ModelCandidate,
  ModelControls,
  ModelDirective,
  ModelEvidence,
  ModelFinishReason,
  ModelAdapter,
  ModelAdapterContext,
  ContextContributor,
  ContextMutationOptions,
  ContextSnapshot,
  ModelCall,
  ModelCallTool,
  ModelOutputBlock,
  PromptContentPart,
  PromptItem,
  ModelConfigurationContributor,
  ModelConfigurationInstruction,
  ModelConfigurationMutationOptions,
  ModelConfigurationSnapshot,
  ModelConfigurationTool,
  ModelRequest,
  ModelToolCall,
  ModelUsage,
} from "./types/model.js";
export type {
  BoundMiddleware,
  StepInput,
  StepMiddleware,
  StepRequest,
  StepResponse,
} from "./types/middleware.js";
export type {
  BuildDiagnostic,
  ContextItem,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  ObserveEvent,
  ObserveModelConfigurationSnapshot,
  ObserveModelRequested,
  ObserveSealedCall,
  ObserveToolSnapshot,
  Observer,
  Tripwire,
} from "./types/shared.js";
export type {
  InteractionReply,
  InputCompletion,
  InputEvent,
  InputHandle,
  InputOptions,
  MessageInput,
  Session,
  SessionInput,
  SessionEvent,
  SessionOptions,
  SessionSnapshot,
  TranscriptEntry,
} from "./types/session.js";
export type {
  BoundToolSchema,
  BoundToolDefinition,
  Interaction,
  PreflightOutcome,
  RequiredInteraction,
  SealedToolCall,
  ToolAdapter,
  AdapterExecutionOptions,
  ToolContent,
  ToolDefinition,
  ToolExecutionResume,
  ToolObjectSchema,
  ToolOutcome,
  ToolResult,
} from "./types/tool.js";
