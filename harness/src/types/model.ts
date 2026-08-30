import type { ContextItem, DeferredOutcome, JsonObject } from "./shared.js";
import type { InputEvent, TranscriptEntry } from "./session.js";
import type { BoundToolDefinition, ToolResult } from "./tool.js";

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
}

export type ModelOutputBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly args: JsonObject;
      readonly raw?: string;
    };

export interface ModelUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalTokens?: number;
  readonly cachedTokens?: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
}

export type ModelFinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "other";

export interface ModelEvidence {
  readonly requestId?: string;
  readonly resolvedModel?: string;
  readonly warnings?: readonly string[];
  readonly extras?: JsonObject;
}

export interface ModelCandidate {
  readonly output: readonly ModelOutputBlock[];
  readonly finishReason?: ModelFinishReason;
  readonly usage?: ModelUsage;
  readonly evidence?: ModelEvidence;
}

export interface ModelControls {
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
}

export interface ModelDirective {
  readonly id?: string;
  readonly controls?: ModelControls;
  readonly config?: JsonObject;
}

/** A middleware-owned declaration for the model-visible configuration. */
export interface ModelConfigurationMutationOptions {
  readonly order?: number;
  readonly reason?: string;
}

export interface ModelConfigurationContributor {
  readonly middlewareId: string;
  readonly slot: string;
  readonly order: number;
  readonly digest: string;
  readonly reason?: string;
}

export interface ModelConfigurationTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly digest: string;
  readonly contributor: ModelConfigurationContributor;
}

export interface ModelConfigurationInstruction {
  readonly text: string;
  readonly digest: string;
  readonly contributor: ModelConfigurationContributor;
}

export interface ModelConfigurationSnapshot {
  readonly version: 1;
  readonly model?: ModelDirective;
  readonly instructions: readonly ModelConfigurationInstruction[];
  /** Bound tools are retained for execution; their digest covers only their provider-visible contract. */
  readonly tools: readonly BoundToolDefinition[];
  readonly toolContracts: readonly ModelConfigurationTool[];
  readonly contributors: readonly ModelConfigurationContributor[];
  readonly digests: Readonly<{
    readonly logical: string;
    readonly model: string;
    readonly request: string;
  }>;
}

/** A middleware-owned declaration for this model call's runtime context. */
export interface ContextMutationOptions {
  readonly order?: number;
  readonly reason?: string;
}

export interface ContextContributor {
  readonly middlewareId: string;
  readonly slot: string;
  readonly order: number;
  readonly digest: string;
  readonly reason?: string;
}

/** Canonical runtime context for one model call. Not part of the configuration digest. */
export interface ContextSnapshot {
  readonly items: readonly ContextItem[];
  readonly contributors: readonly ContextContributor[];
  readonly digest: string;
}

export interface ModelRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  readonly model?: ModelDirective;
  /** Canonical, immutable Harness-owned model configuration for this call. */
  readonly configuration: ModelConfigurationSnapshot;
  readonly instructions: readonly string[];
  readonly context: ContextSnapshot;
  readonly transcript: readonly TranscriptEntry[];
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  /** Tools are normalized and immutable by the time a Model sees them. */
  readonly tools: readonly BoundToolDefinition[];
}

export type PromptContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly args: JsonObject;
    };

export type PromptItem =
  | {
      readonly kind: "instructions";
      readonly role: "system";
      readonly content: readonly PromptContentPart[];
    }
  | {
      readonly kind: "message";
      readonly role: "user" | "assistant";
      readonly content: readonly PromptContentPart[];
    }
  | {
      readonly kind: "tool-result";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "completed" | "denied" | "failed";
      readonly content: readonly PromptContentPart[];
    }
  | {
      readonly kind: "context";
      readonly role: "user";
      readonly content: readonly PromptContentPart[];
    };

export interface ModelCallTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
}

export interface ModelCall {
  readonly model?: ModelDirective;
  readonly prompt: readonly PromptItem[];
  readonly tools: readonly ModelCallTool[];
  readonly sessionId: string;
}

export interface ModelAdapterContext {
  readonly request: ModelRequest;
  readonly invocationId: string;
  readonly signal: AbortSignal;
}

export type ModelAdapter = (
  call: ModelCall,
  context: ModelAdapterContext,
) => Promise<ModelCandidate | string | DeferredOutcome>;
