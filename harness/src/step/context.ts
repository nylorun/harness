import type { BoundModelId, ModelCandidate } from "../types/model.js";
import type { AfterModelContext, BeforeModelContext, StepInput } from "../types/middleware.js";
import type { ContextItem, Tripwire } from "../types/shared.js";
import type { Interaction } from "../types/tool.js";
import { copyJson } from "../utils/immutable.js";

export interface ContextLease<T> {
  readonly value: T;
  revoke(): void;
}

/** Mutable Step state. Middleware only receives the frozen, revocable facades below. */
export class StepContext {
  readonly input: Readonly<StepInput>;
  readonly #boundModels: ReadonlySet<string>;
  readonly #instructions: string[] = [];
  readonly #contextItems: ContextItem[] = [];
  readonly #hiddenTools = new Set<string>();
  readonly #denials = new Map<string, string>();
  readonly #interactions = new Map<string, Interaction>();
  readonly #preflights = new Map<string, "sandbox" | "validation">();
  #selectedModel?: BoundModelId;
  #candidate?: Readonly<ModelCandidate>;
  #tripwire?: Tripwire;
  #sealed = false;

  constructor(input: Readonly<StepInput>, boundModels: ReadonlySet<string>) {
    this.input = input;
    this.#boundModels = boundModels;
  }

  get currentTripwire(): Tripwire | undefined {
    return this.#tripwire;
  }
  get currentCandidate(): Readonly<ModelCandidate> | undefined {
    return this.#candidate;
  }
  get selectedModel(): BoundModelId | undefined {
    return this.#selectedModel;
  }
  get instructions(): readonly string[] {
    return Object.freeze([...this.#instructions]);
  }
  get contextItems(): readonly ContextItem[] {
    return Object.freeze([...this.#contextItems]);
  }

  isToolHidden(toolName: string): boolean {
    return this.#hiddenTools.has(toolName);
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

  setCandidate(candidate: Readonly<ModelCandidate>): void {
    this.#assertOpen();
    this.#candidate = freezeGraph(candidate);
  }

  tripwire(error: Tripwire): void {
    this.#assertOpen();
    this.#tripwire ??= Object.freeze({ ...error });
  }

  seal(): void {
    this.#sealed = true;
  }

  beforeModelFacade(): ContextLease<BeforeModelContext> {
    let active = true;
    const mutate = (action: () => void): void => {
      if (!active) throw new Error("Middleware context is no longer active");
      this.#assertOpen();
      action();
    };
    const value: BeforeModelContext = Object.freeze({
      input: this.input,
      addInstructions: (...items: string[]) =>
        mutate(() => {
          if (items.some((item) => typeof item !== "string"))
            throw new TypeError("Step instructions must be strings");
          this.#instructions.push(...items);
        }),
      addContext: (...items: ContextItem[]) =>
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
      hideTools: (...toolNames: string[]) =>
        mutate(() => {
          if (toolNames.some((name) => typeof name !== "string" || !name))
            throw new TypeError("Hidden Tool names must be non-empty strings");
          toolNames.forEach((name) => this.#hiddenTools.add(name));
        }),
      selectModel: (modelId: BoundModelId) => mutate(() => this.#selectModel(modelId)),
      tripwire: (error: Tripwire) =>
        mutate(() => {
          this.#tripwire ??= Object.freeze({ ...error });
        }),
    });
    return Object.freeze({
      value,
      revoke: () => {
        active = false;
      },
    });
  }

  afterModelFacade(): ContextLease<AfterModelContext> {
    let active = true;
    const mutate = (action: () => void): void => {
      if (!active) throw new Error("Middleware context is no longer active");
      this.#assertOpen();
      action();
    };
    const value: AfterModelContext = Object.freeze({
      input: this.input,
      candidate: () => this.#candidate,
      denyTool: (callId: string, reason: string) =>
        mutate(() => {
          if (!this.#denials.has(callId)) this.#denials.set(callId, reason);
        }),
      requireInteraction: (callId: string, interaction: Interaction) =>
        mutate(() => {
          if (!this.#interactions.has(callId))
            this.#interactions.set(callId, freezeGraph({ ...interaction }));
        }),
      requirePreflight: (callId: string, kind: "sandbox" | "validation") =>
        mutate(() => {
          if (!this.#preflights.has(callId)) this.#preflights.set(callId, kind);
        }),
      tripwire: (error: Tripwire) =>
        mutate(() => {
          this.#tripwire ??= Object.freeze({ ...error });
        }),
    });
    return Object.freeze({
      value,
      revoke: () => {
        active = false;
      },
    });
  }

  #selectModel(modelId: BoundModelId): void {
    if (!this.#boundModels.has(modelId)) {
      this.#tripwire ??= Object.freeze({
        code: "model.not-bound",
        message: `Model '${modelId}' is not bound`,
      });
    } else if (this.#selectedModel && this.#selectedModel !== modelId) {
      this.#tripwire ??= Object.freeze({
        code: "model.selection-conflict",
        message: `Model '${this.#selectedModel}' was already selected`,
      });
    } else {
      this.#selectedModel = modelId;
    }
  }

  #assertOpen(): void {
    if (this.#sealed) throw new Error("Step context is sealed");
  }
}

function freezeGraph<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const item of Object.values(value as Record<string, unknown>)) freezeGraph(item, seen);
  return Object.freeze(value);
}
