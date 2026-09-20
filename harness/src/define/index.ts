export {
  Agent,
  AgentBuilder,
  AgentBuildError,
  AgentLifecycleError,
} from "../definition/builder.js";
export type { AgentOptions } from "../definition/builder.js";
export { HarnessError, isHarnessError } from "../errors.js";
export type { HarnessErrorCode, HarnessErrorDetails, HarnessErrorOptions } from "../errors.js";
export type { BuiltAgent } from "../types/agent.js";
export { capability, middleware, model, tool } from "../definition/helpers.js";
export { ToolError, isToolError } from "../definition/tool-error.js";
export { defineSchema } from "../definition/schema.js";
export type { PreparedModelOptions } from "../execution/model/prepared.js";
export { checkCompatibility } from "../definition/compatibility.js";
export { hashManifest } from "../utils/hash.js";
export type { Implementations } from "../definition/implementations.js";

export type {
  AgentManifest,
  CapabilityManifest,
  ManifestTool,
  ManifestSchemaVersion,
} from "../types/manifest.js";
export type {
  CapabilityDeclaration,
  CapabilityItems,
  MiddlewareContributions,
  StepMiddleware,
  StepRequest,
  StepResponse,
} from "../types/middleware.js";
export type { Patch, Decision, BeforeModelCallFn, AfterModelCallFn } from "../types/dynamics.js";
export type {
  ModelCandidate,
  ModelControls,
  ModelDirective,
  ModelEvidence,
  ModelFinishReason,
  ModelAdapter,
  ModelAdapterContext,
  ModelPreparedCall,
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
} from "../types/model.js";
export type {
  BuildDiagnostic,
  ContextItem,
  DeferredOutcome,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  Tripwire,
} from "../types/shared.js";
export type {
  ObserveEvent,
  ObserveModelConfigurationSnapshot,
  ObserveModelRequested,
  ObserveSealedCall,
  ObserveToolSnapshot,
  Observer,
} from "../types/observe.js";
export type {
  InputEvent,
  MessageInput,
  InteractionReply,
  TranscriptEntry,
  UserContentPart,
} from "../types/transcript.js";
export type {
  ExecutionInput,
  ExecutionState,
  ExecutionEvent,
  RunOptions,
  RunResult,
  SavedToolCall,
  ExecutionPlan,
  ToolReference,
} from "../types/execution.js";

export type {
  Interaction,
  RequiredInteraction,
  ToolContent,
  ToolDefinition,
  ToolDescriptor,
  ToolExecutionContext,
  ToolExecutionResume,
  ToolInputSchema,
  ToolOutputSchema,
  ToolSchema,
  ToolSchemaSource,
  StandardToolSchema,
  StandardSchemaIssue,
  SchemaIssue,
  SchemaValidation,
  SchemaOutput,
  ToolOwner,
  ToolOutcome,
  ToolResult,
  ToolValidationFailureDetails,
  ToolEffects,
  ToolApproval,
  ToolRunResult,
  SessionStateBag,
} from "../types/tool.js";

export { normalizeToolDefinition, normalizedSchemasFor } from "../definition/schema.js";
import { definitionFor } from "../definition/agent-definition.js";
import type { BuiltAgent } from "../types/agent.js";
export function implementationsFor(agent: BuiltAgent) {
  return definitionFor(agent).implementations;
}
