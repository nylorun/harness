import type {
  ContextMutationOptions,
  ModelCandidate,
  ModelDirective,
  ModelToolCall,
  ModelConfigurationMutationOptions,
} from "./model.js";
import type { InputEvent, SessionIdentity, TranscriptEntry } from "./session.js";
import type { ContextItem, JsonObject, Tripwire } from "./shared.js";
import type { Interaction, ToolDefinition, ToolResult } from "./tool.js";

export interface StepInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly stepId: string;
  /** One-based position of this turn within the Session. */
  readonly turnNumber: number;
  /** One-based position of this Model Step within the Turn. */
  readonly stepNumber: number;
  readonly session: Readonly<{
    readonly userId?: string;
    readonly context?: JsonObject;
  }>;
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  readonly transcript: readonly TranscriptEntry[];
}

interface StepRequestBase {
  /** Opaque identity of the Session that owns this Step. */
  readonly sessionId: string;
  /** Opaque identity of the Turn that owns this Step. */
  readonly turnId: string;
  /** Opaque identity of this Model Step. */
  readonly stepId: string;
  readonly session: StepInput["session"];
  readonly turnNumber: number;
  readonly stepNumber: number;
  readonly arrivals: readonly InputEvent[];
  readonly toolResults: readonly ToolResult[];
  readonly transcript: readonly TranscriptEntry[];
  readonly context: {
    set(slot: string, items: readonly ContextItem[], options?: ContextMutationOptions): void;
  };
  readonly configuration: {
    readonly instructions: {
      set(
        slot: string,
        items: readonly string[],
        options?: ModelConfigurationMutationOptions,
      ): void;
    };
    readonly tools: {
      set(
        slot: string,
        tools: readonly ToolDefinition[],
        options?: ModelConfigurationMutationOptions,
      ): void;
    };
    readonly model: {
      select(
        directive: ModelDirective,
        options?: Omit<ModelConfigurationMutationOptions, "order">,
      ): void;
      replace(
        directive: ModelDirective,
        options?: Omit<ModelConfigurationMutationOptions, "order">,
      ): void;
      clear(options?: Omit<ModelConfigurationMutationOptions, "order">): void;
    };
  };
  tripwire(error: Tripwire): StepResponse;
}

export type StepRequest<State = never> = StepRequestBase &
  ([State] extends [never] ? object : { readonly state: Promise<State> });

export interface StepResponse {
  candidate(): Readonly<ModelCandidate> | undefined;
  toolCalls(): readonly ModelToolCall[];
  replace(candidate: ModelCandidate): void;
  deny(callId: string, reason: string): void;
  requireInteraction(callId: string, interaction: Interaction): void;
  tripwire(error: Tripwire): StepResponse;
}

export type StepMiddleware<State = never> = (
  request: StepRequest<State>,
  next: () => Promise<StepResponse>,
) => Promise<StepResponse>;

export interface CapabilityState<State> {
  create(session: SessionIdentity, signal: AbortSignal): State | Promise<State>;
  dispose?(value: State): void | Promise<void>;
}

export type CapabilityItems<Item> =
  readonly Item[] | Readonly<{ readonly slot: string; readonly items: readonly Item[] }>;

/** A named capability that may supply static model surface and one typed middleware handler. */
export interface CapabilityDeclaration<State = never> {
  readonly id: string;
  readonly tools?: CapabilityItems<ToolDefinition<ToolDefinition["parameters"], State>>;
  readonly instructions?: CapabilityItems<string>;
  readonly model?: ModelDirective;
  readonly state?: CapabilityState<State>;
  readonly middleware?: StepMiddleware<State>;
}

export interface MiddlewareContributions {
  readonly instructions?: readonly string[];
  readonly tools?: readonly { readonly name: string; readonly description?: string }[];
  readonly model?: Pick<ModelDirective, "id" | "controls">;
}

export interface BoundMiddleware {
  readonly id: string;
  readonly handle: StepMiddleware;
  readonly state?: CapabilityState<unknown>;
  readonly contributions?: MiddlewareContributions;
}
