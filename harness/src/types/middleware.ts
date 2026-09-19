import type {
  ContextMutationOptions,
  ModelCandidate,
  ModelDirective,
  ModelToolCall,
  ModelConfigurationMutationOptions,
} from "./model.js";
import type { InputEvent, TranscriptEntry } from "./transcript.js";
import type { ContextItem, JsonObject, Tripwire } from "./shared.js";
import type { AfterModelCallFn, BeforeModelCallFn } from "./dynamics.js";
import type { Interaction, ToolDefinition, ToolResult } from "./tool.js";

interface StepRequestBase {
  /** Opaque identity of the execution that owns this Step. */
  readonly executionId: string;
  /** Opaque identity of the Turn that owns this Step. */
  readonly turnId: string;
  /** Opaque identity of this Model Step. */
  readonly stepId: string;

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

export type StepRequest<Info = unknown> = StepRequestBase & { readonly info?: Info };

export interface StepResponse {
  candidate(): Readonly<ModelCandidate> | undefined;
  toolCalls(): readonly ModelToolCall[];
  replace(candidate: ModelCandidate): void;
  deny(callId: string, reason: string): void;
  requireInteraction(callId: string, interaction: Interaction): void;
  tripwire(error: Tripwire): StepResponse;
}

export type StepMiddleware<Info = unknown> = (
  request: StepRequest<Info>,
  next: () => Promise<StepResponse>,
) => Promise<StepResponse>;

export type CapabilityItems<Item> =
  readonly Item[] | Readonly<{ readonly slot: string; readonly items: readonly Item[] }>;

export interface CapabilityDeclaration<Info = unknown> {
  readonly id: string;
  readonly tools?: CapabilityItems<ToolDefinition<any, Info, any>>;
  readonly instructions?: CapabilityItems<string>;
  /**
   * @deprecated Model resolution is Runtime-owned. Not projected into the harness manifest.
   * Kept for local middleware composition through 1.0.
   */
  readonly model?: ModelDirective;
  /** @deprecated Prefer beforeModelCall / afterModelCall. Kept through 1.0. */
  readonly middleware?: StepMiddleware<Info>;
  readonly beforeModelCall?: BeforeModelCallFn<Info>;
  readonly afterModelCall?: AfterModelCallFn<Info>;
}

export interface MiddlewareContributions {
  readonly instructions?: readonly string[];
  readonly tools?: readonly { readonly name: string; readonly description?: string }[];
  readonly model?: Pick<ModelDirective, "id" | "controls">;
}
