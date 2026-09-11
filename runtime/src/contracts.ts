/** Portable values and callable interfaces. No agent engine is required. */
export type JsonValue =
  string | number | boolean | null | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue };
export type UserContentPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "media";
      readonly mediaType: string;
      readonly reference: JsonValue;
    };
export type MessageInput =
  | string
  | { readonly text: string; readonly metadata?: JsonObject }
  | {
      readonly content: readonly UserContentPart[];
      readonly metadata?: JsonObject;
    };
export type InteractionReply =
  | {
      readonly kind: "approve";
      readonly interactionId: string;
      readonly approved: boolean;
    }
  | {
      readonly kind: "respond";
      readonly interactionId: string;
      readonly value: JsonValue;
    };
export type RuntimeInput = MessageInput | InteractionReply;
export type RuntimeInputEvent =
  | InteractionReply
  | {
      readonly kind: "user-message" | "interrupt";
      readonly text?: string;
      readonly content?: readonly UserContentPart[];
    };
/** Lifecycle events are delivered in completion order; other events are diagnostics. */
export interface RuntimeEvent {
  readonly type: string;
  readonly output?: JsonValue;
  readonly event?: RuntimeInputEvent;
  readonly interaction?: unknown;
  readonly attributes?: unknown;
  readonly tripwire?: { readonly code: string; readonly message?: string };
}
export interface RuntimeCompletion {
  readonly status:
    "completed" | "waiting" | "rejected" | "cancelled" | "stopped";
  readonly events: readonly RuntimeEvent[];
}
export interface RuntimeSession {
  readonly id: string;
  input(
    event: RuntimeInput,
    options?: { readonly signal?: AbortSignal },
  ): { readonly completed: Promise<RuntimeCompletion> };
  stream(): AsyncIterable<RuntimeEvent>;
  stop(reason?: string): Promise<void>;
}
export interface RuntimeRunOptions {
  readonly id?: string;
  readonly userId?: string;
  readonly context?: JsonObject;
  readonly onModelCall: RuntimeModelAdapter;
  readonly observer?: { (event: { readonly type: string }): void | Promise<void> };
}
export interface RuntimeAgent {
  readonly id: string;
  readonly name: string;
  readonly manifest: { readonly id: string; readonly name: string };
  run(options: RuntimeRunOptions): RuntimeSession;
  close?(): Promise<void>;
}
export type PromptContentPart =
  | Exclude<UserContentPart, { readonly type: "text" }>
  | {
      readonly type: "text" | "reasoning";
      readonly text: string;
      readonly providerMetadata?: JsonObject;
    }
  | {
      readonly type: "tool-call";
      readonly providerMetadata?: JsonObject;
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
      readonly kind: "context";
      readonly role: "user";
      readonly content: readonly PromptContentPart[];
    }
  | {
      readonly kind: "tool-result";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly status: "completed" | "denied" | "failed";
      readonly content: readonly PromptContentPart[];
    };
export interface RuntimeModelCall {
  readonly sessionId: string;
  readonly prompt: readonly PromptItem[];
  readonly tools: readonly {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: JsonObject;
  }[];
  readonly outputSchema?: JsonObject;
  readonly model?: {
    readonly id?: string;
    readonly controls?: {
      readonly temperature?: number;
      readonly maxOutputTokens?: number;
    };
    readonly config?: JsonObject;
  };
}
export interface RuntimeModelCandidate {
  readonly output: readonly (
    | {
        readonly type: "text" | "reasoning";
        readonly text: string;
        readonly providerMetadata?: JsonObject;
      }
    | { readonly type: "json"; readonly value: JsonValue }
    | {
        readonly type: "tool-call";
        readonly providerMetadata?: JsonObject;
        readonly id: string;
        readonly name: string;
        readonly args: JsonObject;
      }
  )[];
  readonly finishReason?:
    "stop" | "length" | "tool-calls" | "content-filter" | "other";
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
    readonly costUsd?: number;
  };
  readonly evidence?: { readonly resolvedModel?: string };
}
export interface RuntimeModelContext {
  readonly signal: AbortSignal;
  reportPreparedCall?(prepared: {
    readonly adapter: string;
    readonly call: JsonValue;
  }): void;
}
export type RuntimeModelAdapter = (
  call: RuntimeModelCall,
  context: RuntimeModelContext,
) => Promise<RuntimeModelCandidate>;
