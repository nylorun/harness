import type { ModelCandidate, ModelDirective } from "../types/model.js";
import type { StepInput, StepRequest, StepResponse } from "../types/middleware.js";
import type { ContextItem, ObserveEvent, Tripwire } from "../types/shared.js";
import type { BoundToolDefinition, Interaction, ToolDefinition } from "../types/tool.js";
import { bindTool } from "../build/bind-tool.js";
import type { AdapterRegistry } from "../build/adapters.js";
import { copyJson } from "../utils/immutable.js";
import {
  callsFromCanonical,
  candidateFromCanonical,
  canonicalizeOutput,
  identityKey,
  type CanonicalCall,
} from "./canonicalize.js";
import { normalizeCandidate, normalizeDirective, sameDirective } from "../types/model.js";

const branded = new WeakSet<object>();

export function isBrandedResponse(value: unknown): value is StepResponse {
  return typeof value === "object" && value !== null && branded.has(value);
}

/** Mutable Step state. Middleware receives leased request views and one branded response. */
export class StepContext {
  readonly input: Readonly<StepInput>;
  readonly #adapters: AdapterRegistry;
  readonly #observe: (event: ObserveEvent) => void;
  readonly #instructions: string[] = [];
  readonly #contextItems: ContextItem[] = [];
  readonly #catalog: BoundToolDefinition[] = [];
  readonly #hiddenTools = new Set<string>();
  readonly #denials = new Map<string, string>();
  readonly #interactions = new Map<string, Interaction>();
  readonly #preflights = new Map<string, "sandbox" | "validation">();
  readonly #identities = new Map<string, string>();
  #selectedDirective?: ModelDirective;
  #canonical: readonly CanonicalCall[] = Object.freeze([]);
  #candidate?: ModelCandidate;
  #tripwire?: Tripwire;
  #response?: StepResponse;
  #sealed = false;

  constructor(
    input: Readonly<StepInput>,
    adapters: AdapterRegistry,
    observe: (event: ObserveEvent) => void,
  ) {
    this.input = input;
    this.#adapters = adapters;
    this.#observe = observe;
  }

  get currentTripwire(): Tripwire | undefined {
    return this.#tripwire;
  }
  get currentCandidate(): Readonly<ModelCandidate> | undefined {
    return this.#candidate;
  }
  get selectedDirective(): ModelDirective | undefined {
    return this.#selectedDirective;
  }
  get instructions(): readonly string[] {
    return Object.freeze([...this.#instructions]);
  }
  get contextItems(): readonly ContextItem[] {
    return Object.freeze([...this.#contextItems]);
  }
  get offeredTools(): readonly BoundToolDefinition[] {
    return Object.freeze(this.#catalog.filter((tool) => !this.#hiddenTools.has(tool.name)));
  }
  get catalogByName(): ReadonlyMap<string, BoundToolDefinition> {
    return new Map(this.#catalog.map((tool) => [tool.name, tool]));
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

  requestFacade(middlewareId: string): {
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
          attributes: {
            middlewareId,
            reason: this.#sealed ? "step-sealed" : "mutators-revoked",
          },
        });
        throw new Error("Middleware request mutators are no longer active");
      }
      action();
    };
    const value: StepRequest = Object.freeze({
      session: this.input.session,
      turnNumber: this.input.turnNumber,
      stepNumber: this.input.stepNumber,
      arrivals: this.input.arrivals,
      toolResults: this.input.toolResults,
      transcript: this.input.transcript,
      instructions: Object.freeze({
        add: (...items: string[]) =>
          mutate(() => {
            if (items.some((item) => typeof item !== "string"))
              throw new TypeError("Step instructions must be strings");
            this.#instructions.push(...items);
          }),
      }),
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
      tools: Object.freeze({
        add: (...tools: ToolDefinition[]) =>
          mutate(() => {
            for (const tool of tools) this.#addTool(tool);
          }),
        hide: (...toolNames: string[]) =>
          mutate(() => {
            if (toolNames.some((name) => typeof name !== "string" || !name))
              throw new TypeError("Hidden Tool names must be non-empty strings");
            toolNames.forEach((name) => this.#hiddenTools.add(name));
          }),
      }),
      model: Object.freeze({
        select: (directive: ModelDirective) => mutate(() => this.#selectDirective(directive)),
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

  #addTool(item: ToolDefinition): void {
    try {
      const bound = bindTool(item, this.#adapters);
      if (this.#catalog.some((tool) => tool.name === bound.name)) {
        this.#tripwire ??= Object.freeze({
          code: "tool.duplicate-name",
          message: `Duplicate Tool '${bound.name}'`,
          scope: "step" as const,
        });
        return;
      }
      this.#catalog.push(bound);
    } catch (cause) {
      this.#tripwire ??= Object.freeze({
        code: "tool.invalid",
        message: `Tool '${item.name ?? "unknown"}' is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
        scope: "step" as const,
      });
    }
  }

  #selectDirective(value: ModelDirective): void {
    const normalized = normalizeDirective(value);
    if (normalized instanceof Error) {
      this.#tripwire ??= Object.freeze({
        code: "model.invalid-directive",
        message: normalized.message,
      });
      return;
    }
    if (this.#selectedDirective && !sameDirective(this.#selectedDirective, normalized)) {
      this.#tripwire ??= Object.freeze({
        code: "model.selection-conflict",
        message: "A different model directive was already selected",
      });
      return;
    }
    this.#selectedDirective = normalized;
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
