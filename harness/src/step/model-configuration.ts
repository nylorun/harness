import type {
  ModelConfigurationContributor,
  ModelConfigurationInstruction,
  ModelConfigurationMutationOptions,
  ModelConfigurationSnapshot,
  ModelConfigurationTool,
  ModelDirective,
} from "../types/model.js";
import type { BoundToolDefinition, ToolDefinition } from "../types/tool.js";
import type { AdapterRegistry } from "../build/adapters.js";
import { bindTool } from "../build/bind-tool.js";
import { HarnessError, isHarnessError } from "../errors.js";
import { normalizeDirective, sameDirective } from "../model-normalize.js";
import { digest } from "../utils/digest.js";
import { copyJson } from "../utils/immutable.js";
import { checkedReason, slotOwner, SlotDraft, type SlotOwner } from "./slot-assembly.js";

interface ModelSelection {
  readonly directive: ModelDirective;
  readonly owner?: SlotOwner;
  readonly reason?: string;
}

/** Per-step, middleware-owned model configuration draft. It never persists past the call. */
export class ModelConfigurationDraft {
  #instructions = new SlotDraft<readonly string[]>();
  #tools = new SlotDraft<readonly BoundToolDefinition[]>();
  #model?: ModelSelection;

  constructor(
    private readonly adapters: AdapterRegistry,
    directive?: ModelDirective,
  ) {
    if (directive !== undefined)
      this.#model = Object.freeze({ directive: checkedDirective(directive) });
  }

  setInstructions(
    middlewareId: string,
    middlewareOrder: number,
    slot: string,
    items: readonly string[],
    options?: ModelConfigurationMutationOptions,
  ): void {
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string"))
      throw new HarnessError(
        "configuration.invalid-instructions",
        "Model configuration instructions must be strings",
      );
    this.#instructions.set({
      middlewareId,
      middlewareOrder,
      slot,
      value: Object.freeze([...items]),
      order: options?.order,
      reason: options?.reason,
      invalidSlot: "configuration.invalid-slot",
      invalidOrder: "configuration.invalid-order",
      invalidReason: "configuration.invalid-reason",
      label: "Model configuration",
    });
  }

  setTools(
    middlewareId: string,
    middlewareOrder: number,
    slot: string,
    tools: readonly ToolDefinition[],
    options?: ModelConfigurationMutationOptions,
  ): void {
    if (!Array.isArray(tools))
      throw new HarnessError(
        "configuration.invalid-tools",
        "Model configuration tools must be an array",
      );
    this.#tools.set({
      middlewareId,
      middlewareOrder,
      slot,
      value: Object.freeze(tools.map((tool) => bindTool(tool, this.adapters))),
      order: options?.order,
      reason: options?.reason,
      invalidSlot: "configuration.invalid-slot",
      invalidOrder: "configuration.invalid-order",
      invalidReason: "configuration.invalid-reason",
      label: "Model configuration",
    });
  }

  select(
    middlewareId: string,
    middlewareOrder: number,
    directive: ModelDirective,
    options?: Omit<ModelConfigurationMutationOptions, "order">,
  ): void {
    const normalized = checkedDirective(directive);
    if (this.#model && !sameDirective(this.#model.directive, normalized))
      throw new HarnessError(
        "configuration.model-selection-conflict",
        "A different model directive is already selected; use model.replace() to change it",
      );
    this.#model = Object.freeze({
      directive: normalized,
      owner: slotOwner(middlewareId, middlewareOrder, "model"),
      ...(options?.reason === undefined
        ? {}
        : {
            reason: checkedReason(
              options.reason,
              "configuration.invalid-reason",
              "Model configuration",
            ),
          }),
    });
  }

  replace(
    middlewareId: string,
    middlewareOrder: number,
    directive: ModelDirective,
    options?: Omit<ModelConfigurationMutationOptions, "order">,
  ): void {
    this.#model = Object.freeze({
      directive: checkedDirective(directive),
      owner: slotOwner(middlewareId, middlewareOrder, "model"),
      ...(options?.reason === undefined
        ? {}
        : {
            reason: checkedReason(
              options.reason,
              "configuration.invalid-reason",
              "Model configuration",
            ),
          }),
    });
  }

  clear(options?: Omit<ModelConfigurationMutationOptions, "order">): void {
    if (options?.reason !== undefined)
      checkedReason(options.reason, "configuration.invalid-reason", "Model configuration");
    this.#model = undefined;
  }

  snapshot(): ModelConfigurationSnapshot {
    const instructionSlots = this.#instructions.values();
    const toolSlots = this.#tools.values();
    const instructions = instructionSlots.flatMap((slot) =>
      slot.value.map((text) =>
        Object.freeze({
          text,
          digest: digest(text),
          contributor: contributor(slot.owner, slot.reason),
        }),
      ),
    );
    const sourcedTools = toolSlots.flatMap((slot) =>
      slot.value.map((tool) =>
        Object.freeze({ tool, contributor: contributor(slot.owner, slot.reason) }),
      ),
    );
    const seen = new Set<string>();
    const duplicate = new Set<string>();
    for (const item of sourcedTools) {
      if (seen.has(item.tool.name)) duplicate.add(item.tool.name);
      seen.add(item.tool.name);
    }
    if (duplicate.size)
      throw new HarnessError(
        "configuration.duplicate-tool-name",
        `Duplicate Tool '${[...duplicate].sort().join("', '")}'`,
      );
    const toolContracts = sourcedTools.map(({ tool, contributor: source }) =>
      toolContract(tool, source),
    );
    const model = this.#model?.directive;
    const logical = digest({
      instructions: instructions.map((item) => item.text),
      tools: toolContracts.map(({ name, description, inputSchema }) => ({
        name,
        ...(description === undefined ? {} : { description }),
        inputSchema,
      })),
    });
    const modelDigest = digest(model ?? null);
    return Object.freeze({
      version: 1,
      ...(model === undefined ? {} : { model }),
      instructions: Object.freeze(instructions),
      tools: Object.freeze(sourcedTools.map((item) => item.tool)),
      toolContracts: Object.freeze(toolContracts),
      contributors: Object.freeze([
        ...instructionSlots.map((slot) => contributor(slot.owner, slot.reason)),
        ...toolSlots.map((slot) => contributor(slot.owner, slot.reason)),
        ...(this.#model?.owner ? [contributor(this.#model.owner, this.#model.reason)] : []),
      ]),
      digests: Object.freeze({
        logical,
        model: modelDigest,
        request: digest({ logical, model: modelDigest }),
      }),
    });
  }
}

function checkedDirective(value: ModelDirective): ModelDirective {
  const normalized = normalizeDirective(value);
  if (isHarnessError(normalized)) throw normalized;
  return normalized;
}

function contributor(owner: SlotOwner, reason?: string): ModelConfigurationContributor {
  return Object.freeze({
    middlewareId: owner.middlewareId,
    slot: owner.slot,
    order: owner.order,
    digest: digest({ middlewareId: owner.middlewareId, slot: owner.slot, order: owner.order }),
    ...(reason === undefined ? {} : { reason }),
  });
}

function providerTool(tool: BoundToolDefinition): object {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: copyJson(tool.parameters.jsonSchema),
  };
}

function toolContract(
  tool: BoundToolDefinition,
  source: ModelConfigurationContributor,
): ModelConfigurationTool {
  const value = providerTool(tool) as {
    name: string;
    description?: string;
    inputSchema: import("../types/shared.js").JsonObject;
  };
  return Object.freeze({ ...value, digest: digest(value), contributor: source });
}
