import type { ContextItem, JsonObject } from "./shared.js";
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

/** A middleware-owned change to the model-visible prefix. */
export interface PromptPrefixMutationOptions {
  readonly order?: number;
  readonly reason?: string;
}

export interface PromptPrefixContributor {
  readonly middlewareId: string;
  readonly slot: string;
  readonly order: number;
  readonly digest: string;
  readonly reason?: string;
}

export interface PromptPrefixTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly digest: string;
  readonly contributor: PromptPrefixContributor;
}

export interface PromptPrefixInstruction {
  readonly text: string;
  readonly digest: string;
  readonly contributor: PromptPrefixContributor;
}

export interface PromptPrefixSnapshot {
  readonly version: 1;
  readonly model?: ModelDirective;
  readonly instructions: readonly PromptPrefixInstruction[];
  /** Bound tools are retained for execution; their digest covers only their provider-visible contract. */
  readonly tools: readonly BoundToolDefinition[];
  readonly toolContracts: readonly PromptPrefixTool[];
  readonly contributors: readonly PromptPrefixContributor[];
  readonly digests: Readonly<{
    readonly logical: string;
    readonly model: string;
    readonly request: string;
  }>;
}

export type ContextLifetime = "step" | "turn" | "session";

/** A middleware-owned change to the model-visible context ledger. */
export interface ContextMutationOptions {
  readonly order?: number;
  readonly reason?: string;
  readonly lifetime?: ContextLifetime;
}

export interface ContextContributor {
  readonly middlewareId: string;
  readonly slot: string;
  readonly order: number;
  readonly lifetime: ContextLifetime;
  readonly digest: string;
  readonly reason?: string;
}

/** Committed context ledger for one model call. Not part of the prefix digest. */
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
  /** Canonical, immutable Harness-owned model prefix for this call. */
  readonly prefix: PromptPrefixSnapshot;
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
  readonly signal: AbortSignal;
}

export type ModelAdapter = (
  call: ModelCall,
  context: ModelAdapterContext,
) => Promise<ModelCandidate | string>;
