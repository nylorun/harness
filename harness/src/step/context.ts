import type {
  ModelCandidate,
  ModelDirective,
  PromptPrefixMutationOptions,
  PromptPrefixSnapshot,
} from "../types/model.js";
import type { StepInput, StepRequest, StepResponse } from "../types/middleware.js";
import type { ContextItem, ObserveEvent, Tripwire } from "../types/shared.js";
import type { BoundToolDefinition, Interaction, ToolDefinition } from "../types/tool.js";
import { copyJson } from "../utils/immutable.js";
import {
  callsFromCanonical,
  candidateFromCanonical,
  canonicalizeOutput,
  identityKey,
  type CanonicalCall,
} from "./canonicalize.js";
import { normalizeCandidate } from "../types/model.js";
import { owner, PromptPrefixTransaction } from "./prompt-prefix.js";

const branded = new WeakSet<object>();

export function isBrandedResponse(value: unknown): value is StepResponse {
  return typeof value === "object" && value !== null && branded.has(value);
}

/** Mutable Step state. Middleware receives leased request views and one branded response. */
export class StepContext {
  readonly input: Readonly<StepInput>;
  readonly #observe: (event: ObserveEvent) => void;
  readonly #contextItems: ContextItem[] = [];
  readonly #prefix: PromptPrefixTransaction;
  readonly #denials = new Map<string, string>();
  readonly #interactions = new Map<string, Interaction>();
  readonly #preflights = new Map<string, "sandbox" | "validation">();
  readonly #identities = new Map<string, string>();
  #canonical: readonly CanonicalCall[] = Object.freeze([]);
  #candidate?: ModelCandidate;
  #tripwire?: Tripwire;
  #response?: StepResponse;
  #sealed = false;
  #committedPrefix?: PromptPrefixSnapshot;

  constructor(
    input: Readonly<StepInput>,
    observe: (event: ObserveEvent) => void,
    prefix: PromptPrefixTransaction,
  ) {
    this.input = input;
    this.#observe = observe;
    this.#prefix = prefix;
  }

  get currentTripwire(): Tripwire | undefined {
    return this.#tripwire;
  }
  get currentCandidate(): Readonly<ModelCandidate> | undefined {
    return this.#candidate;
  }
  get selectedDirective(): ModelDirective | undefined {
    return this.prefixSnapshot().model;
  }
  get instructions(): readonly string[] {
    return Object.freeze(this.prefixSnapshot().instructions.map((item) => item.text));
  }
  get contextItems(): readonly ContextItem[] {
    return Object.freeze([...this.#contextItems]);
  }
  get offeredTools(): readonly BoundToolDefinition[] {
    return this.prefixSnapshot().tools;
  }
  get catalogByName(): ReadonlyMap<string, BoundToolDefinition> {
    return this.#prefix.catalogByName();
  }

  isToolHidden(toolName: string): boolean {
    return this.#prefix.isWithheld(toolName);
  }
  prefixSnapshot(): PromptPrefixSnapshot {
    return this.#committedPrefix ?? this.#prefix.snapshot();
  }
  commitPrefix(snapshot: PromptPrefixSnapshot): void {
    this.#committedPrefix = snapshot;
  }
  denialFor(callId: string): string | undefined {
    return this.#denials.get(callId);
  }
  interactionFor(callId: string): Interaction | undefined {
    return this.#interactions.get(callId);
  }
  preflightFor(callId: string): "sandbox" | "validation" | undefined {
    return this.#preflights.get(callId);
  }
  canonicalCalls(): readonly CanonicalCall[] {
    return this.#canonical;
  }

  mintFromModel(candidate: Readonly<ModelCandidate>): StepResponse {
    const { output, calls } = canonicalizeOutput(candidate.output);
    this.#canonical = calls;
    this.#candidate = candidateFromCanonical(candidate, output);
    this.#identities.clear();
    for (const call of calls) this.#identities.set(call.id, identityKey(call.name, call.args));
    return this.#ensureResponse();
  }

  tripwire(error: Tripwire): StepResponse {
    this.#tripwire ??= Object.freeze({ ...error });
    return this.#ensureResponse();
  }

  seal(): void {
    this.#sealed = true;
  }

  requestFacade(
    middlewareId: string,
    middlewareOrder: number,
  ): {
    readonly value: StepRequest;
    revokeMutators(): void;
  } {
    let mutatorsActive = true;
    const mutate = (action: () => void): void => {
      if (!mutatorsActive || this.#sealed) {
        this.#observe({
          type: "middleware.lease-violation",
          turnId: this.input.turnId,
          stepId: this.input.stepId,
          middlewareId,
          reason: this.#sealed ? "step-sealed" : "mutators-revoked",
        });
        throw new Error("Middleware request mutators are no longer active");
      }
      action();
    };
    const mutatePrefix = (kind: "instructions" | "tools" | "model", action: () => void): void =>
      mutate(() => {
        try {
          action();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          const code =
            kind === "tools"
              ? "tool.invalid"
              : kind === "model"
                ? message.startsWith("A different model directive")
                  ? "model.selection-conflict"
                  : "model.invalid-directive"
                : "prefix.invalid";
          this.#tripwire ??= Object.freeze({ code, message });
        }
      });
    const value: StepRequest = Object.freeze({
      session: this.input.session,
      turnNumber: this.input.turnNumber,
      stepNumber: this.input.stepNumber,
      arrivals: this.input.arrivals,
      toolResults: this.input.toolResults,
      transcript: this.input.transcript,
      context: Object.freeze({
        add: (...items: ContextItem[]) =>
          mutate(() => {
            this.#contextItems.push(
              ...items.map((item) => {
                if (!item || typeof item !== "object")
                  throw new TypeError("Step context items must be objects");
                if (item.type !== undefined && typeof item.type !== "string")
                  throw new TypeError("Step context item type must be a string");
                return Object.freeze({
                  ...(item.type === undefined ? {} : { type: item.type }),
                  value: copyJson(item.value),
                });
              }),
            );
          }),
      }),
      prefix: Object.freeze({
        instructions: Object.freeze({
          set: (slot: string, items: readonly string[], options?: PromptPrefixMutationOptions) =>
            mutatePrefix("instructions", () =>
              this.#prefix.setInstructions(
                owner(middlewareId, middlewareOrder, slot),
                items,
                options,
              ),
            ),
          remove: (slot: string, options?: Omit<PromptPrefixMutationOptions, "order">) =>
            mutatePrefix("instructions", () =>
              this.#prefix.removeInstructions(owner(middlewareId, middlewareOrder, slot), options),
            ),
        }),
        tools: Object.freeze({
          set: (
            slot: string,
            tools: readonly ToolDefinition[],
            options?: PromptPrefixMutationOptions,
          ) =>
            mutatePrefix("tools", () =>
              this.#prefix.setTools(owner(middlewareId, middlewareOrder, slot), tools, options),
            ),
          remove: (slot: string, options?: Omit<PromptPrefixMutationOptions, "order">) =>
            mutatePrefix("tools", () =>
              this.#prefix.removeTools(owner(middlewareId, middlewareOrder, slot), options),
            ),
          withhold: (name: string, options?: Omit<PromptPrefixMutationOptions, "order">) =>
            mutatePrefix("tools", () =>
              this.#prefix.withhold(
                owner(middlewareId, middlewareOrder, `withhold:${name}`),
                name,
                options,
              ),
            ),
          restore: (name: string, options?: Omit<PromptPrefixMutationOptions, "order">) =>
            mutatePrefix("tools", () => this.#prefix.restore(name, options)),
        }),
        model: Object.freeze({
          select: (
            directive: ModelDirective,
            options?: Omit<PromptPrefixMutationOptions, "order">,
          ) =>
            mutatePrefix("model", () =>
              this.#prefix.select(
                owner(middlewareId, middlewareOrder, "model"),
                directive,
                options,
              ),
            ),
          replace: (
            directive: ModelDirective,
            options?: Omit<PromptPrefixMutationOptions, "order">,
          ) =>
            mutatePrefix("model", () =>
              this.#prefix.replace(
                owner(middlewareId, middlewareOrder, "model"),
                directive,
                options,
              ),
            ),
          clear: (options?: Omit<PromptPrefixMutationOptions, "order">) =>
            mutatePrefix("model", () => this.#prefix.clearModel(options)),
        }),
      }),
      tripwire: (error: Tripwire) => {
        let minted!: StepResponse;
        mutate(() => {
          minted = this.tripwire(error);
        });
        return minted;
      },
    });
    return Object.freeze({
      value,
      revokeMutators: () => {
        mutatorsActive = false;
      },
    });
  }

  #ensureResponse(): StepResponse {
    if (this.#response) return this.#response;
    const value: StepResponse = Object.freeze({
      candidate: () => this.currentCandidate,
      toolCalls: () => callsFromCanonical(this.#canonical),
      replace: (candidate: ModelCandidate) => this.#replace(candidate),
      deny: (callId: string, reason: string) => {
        if (!this.#denials.has(callId)) this.#denials.set(callId, reason);
      },
      requireInteraction: (callId: string, interaction: Interaction) => {
        if (!this.#interactions.has(callId))
          this.#interactions.set(callId, freezeGraph({ ...interaction }));
      },
      requirePreflight: (callId: string, kind: "sandbox" | "validation") => {
        if (!this.#preflights.has(callId)) this.#preflights.set(callId, kind);
      },
      tripwire: (error: Tripwire) => {
        this.#tripwire ??= Object.freeze({ ...error });
      },
    });
    branded.add(value);
    this.#response = value;
    return value;
  }

  #replace(candidate: ModelCandidate): void {
    let normalized: ModelCandidate;
    try {
      normalized = normalizeCandidate(candidate);
    } catch (error) {
      this.#tripwire ??= Object.freeze({
        code: "response.replace-invalid",
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const { output, calls: next } = canonicalizeOutput(normalized.output);
    for (const call of next) {
      const original = this.#identities.get(call.id);
      if (original === undefined) {
        this.#tripwire ??= Object.freeze({
          code: "response.replace-invalid",
          message: `replace() cannot add Tool call '${call.id}'`,
        });
        return;
      }
      if (original !== identityKey(call.name, call.args)) {
        this.#tripwire ??= Object.freeze({
          code: "response.replace-invalid",
          message: `replace() cannot change identity of Tool call '${call.id}'`,
        });
        return;
      }
    }
    const current = this.#candidate;
    this.#canonical = next;
    this.#candidate = Object.freeze({
      output,
      ...pickSidecar("finishReason", candidate, normalized, current),
      ...pickSidecar("usage", candidate, normalized, current),
      ...pickSidecar("evidence", candidate, normalized, current),
    });
  }
}

function pickSidecar(
  key: "finishReason" | "usage" | "evidence",
  replacement: ModelCandidate,
  normalized: ModelCandidate,
  current: ModelCandidate | undefined,
): Partial<Pick<ModelCandidate, "finishReason" | "usage" | "evidence">> {
  const source = Object.hasOwn(replacement, key) ? normalized : current;
  const value = source?.[key];
  return value === undefined ? {} : { [key]: value };
}

function freezeGraph<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value as Record<string, unknown>)) freezeGraph(item, seen);
  return Object.freeze(value);
}
