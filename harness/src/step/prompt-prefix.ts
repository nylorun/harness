import type {
  ModelDirective,
  PromptPrefixContributor,
  PromptPrefixInstruction,
  PromptPrefixMutationOptions,
  PromptPrefixSnapshot,
  PromptPrefixTool,
} from "../types/model.js";
import type { ToolDefinition, BoundToolDefinition } from "../types/tool.js";
import type { AdapterRegistry } from "../build/adapters.js";
import { bindTool } from "../build/bind-tool.js";
import { normalizeDirective, sameDirective } from "../types/model.js";
import { digest } from "../utils/digest.js";
import { copyJson } from "../utils/immutable.js";

export type PromptPrefixStatus = "initial" | "unchanged" | "declared-change" | "drift";
export type PromptPrefixPolicy = "observe" | "strict";

export interface PromptPrefixLedgerEntry {
  readonly status: PromptPrefixStatus;
  readonly snapshot: PromptPrefixSnapshot;
  readonly previous?: PromptPrefixSnapshot;
}

interface InstructionSlot {
  readonly owner: Owner;
  readonly items: readonly string[];
  readonly reason?: string;
}
interface ToolSlot {
  readonly owner: Owner;
  readonly tools: readonly BoundToolDefinition[];
  readonly reason?: string;
}
interface ModelSelection {
  readonly directive: ModelDirective;
  readonly owner?: Owner;
  readonly reason?: string;
}
interface WithheldTool {
  readonly owner: Owner;
  readonly reason?: string;
}
interface Owner {
  readonly middlewareId: string;
  readonly middlewareOrder: number;
  readonly slot: string;
  readonly order: number;
}
interface Mutation {
  readonly changed: boolean;
  readonly reason?: string;
}
interface State {
  readonly instructions: ReadonlyMap<string, InstructionSlot>;
  readonly tools: ReadonlyMap<string, ToolSlot>;
  readonly withheld: ReadonlyMap<string, WithheldTool>;
  readonly model?: ModelSelection;
  readonly snapshot?: PromptPrefixSnapshot;
}

/** Session-scoped prefix state. Only named transactions can alter its effective prefix. */
export class PromptPrefixState {
  #state: State;

  constructor(
    readonly policy: PromptPrefixPolicy = "observe",
    directive?: ModelDirective,
  ) {
    this.#state = seededState(directive);
  }

  begin(adapters: AdapterRegistry): PromptPrefixTransaction {
    return new PromptPrefixTransaction(this.#state, adapters);
  }

  preview(
    transaction: PromptPrefixTransaction,
    next = transaction.snapshot(),
  ): PromptPrefixLedgerEntry {
    const previous = this.#state.snapshot;
    const status: PromptPrefixStatus =
      previous === undefined
        ? "initial"
        : previous.digests.request === next.digests.request
          ? "unchanged"
          : "declared-change";
    if (
      this.policy === "strict" &&
      status === "declared-change" &&
      transaction.hasUnreasonedChange()
    )
      throw new Error("Prompt prefix changed without a mutation reason in strict mode");
    const snapshot = status === "unchanged" ? previous! : next;
    return Object.freeze({ status, snapshot, ...(previous === undefined ? {} : { previous }) });
  }

  commit(transaction: PromptPrefixTransaction, entry: PromptPrefixLedgerEntry): void {
    this.#state = transaction.state(entry.snapshot);
  }
}

export class PromptPrefixTransaction {
  #instructions: Map<string, InstructionSlot>;
  #tools: Map<string, ToolSlot>;
  #withheld: Map<string, WithheldTool>;
  #model?: ModelSelection;
  #mutations: Mutation[] = [];

  constructor(
    previous: State,
    private readonly adapters: AdapterRegistry,
  ) {
    this.#instructions = new Map(previous.instructions);
    this.#tools = new Map(previous.tools);
    this.#withheld = new Map(previous.withheld);
    this.#model = previous.model;
  }

  setInstructions(
    owner: Owner,
    items: readonly string[],
    options?: PromptPrefixMutationOptions,
  ): void {
    validateSlot(owner.slot);
    if (!Array.isArray(items) || items.some((item) => typeof item !== "string"))
      throw new TypeError("Prompt prefix instructions must be strings");
    const key = slotKey(owner);
    const prior = this.#instructions.get(key);
    const entry = Object.freeze({
      owner: withOrder(owner, options, prior?.owner.order),
      items: Object.freeze([...items]),
      ...(options?.reason === undefined ? {} : { reason: validateReason(options.reason) }),
    });
    this.#instructions.set(key, entry);
    this.#mutations.push({ changed: !sameInstructionSlot(prior, entry), reason: options?.reason });
  }

  removeInstructions(owner: Owner, options?: Omit<PromptPrefixMutationOptions, "order">): void {
    validateSlot(owner.slot);
    const changed = this.#instructions.delete(slotKey(owner));
    this.#mutations.push({ changed, reason: options?.reason });
  }

  setTools(
    owner: Owner,
    tools: readonly ToolDefinition[],
    options?: PromptPrefixMutationOptions,
  ): void {
    validateSlot(owner.slot);
    if (!Array.isArray(tools)) throw new TypeError("Prompt prefix tools must be an array");
    const bound = Object.freeze(tools.map((tool) => bindTool(tool, this.adapters)));
    const key = slotKey(owner);
    const prior = this.#tools.get(key);
    const entry = Object.freeze({
      owner: withOrder(owner, options, prior?.owner.order),
      tools: bound,
      ...(options?.reason === undefined ? {} : { reason: validateReason(options.reason) }),
    });
    this.#tools.set(key, entry);
    this.#mutations.push({ changed: !sameToolSlot(prior, entry), reason: options?.reason });
  }

  removeTools(owner: Owner, options?: Omit<PromptPrefixMutationOptions, "order">): void {
    validateSlot(owner.slot);
    const changed = this.#tools.delete(slotKey(owner));
    this.#mutations.push({ changed, reason: options?.reason });
  }

  withhold(owner: Owner, name: string, options?: Omit<PromptPrefixMutationOptions, "order">): void {
    validateToolName(name);
    const prior = this.#withheld.get(name);
    const entry = Object.freeze({
      owner: withOrder(owner, options),
      ...(options?.reason === undefined ? {} : { reason: validateReason(options.reason) }),
    });
    this.#withheld.set(name, entry);
    this.#mutations.push({
      changed: prior === undefined || !sameOwner(prior.owner, entry.owner),
      reason: options?.reason,
    });
  }

  restore(name: string, options?: Omit<PromptPrefixMutationOptions, "order">): void {
    validateToolName(name);
    const changed = this.#withheld.delete(name);
    this.#mutations.push({ changed, reason: options?.reason });
  }

  select(
    owner: Owner,
    directive: ModelDirective,
    options?: Omit<PromptPrefixMutationOptions, "order">,
  ): void {
    const normalized = checkedDirective(directive);
    if (this.#model && !sameDirective(this.#model.directive, normalized))
      throw new Error(
        "A different model directive is already selected; use model.replace() to change it",
      );
    const entry = Object.freeze({
      directive: normalized,
      owner: withOrder(owner, options),
      ...(options?.reason === undefined ? {} : { reason: validateReason(options.reason) }),
    });
    const changed = this.#model === undefined;
    this.#model = entry;
    this.#mutations.push({ changed, reason: options?.reason });
  }

  replace(
    owner: Owner,
    directive: ModelDirective,
    options?: Omit<PromptPrefixMutationOptions, "order">,
  ): void {
    const normalized = checkedDirective(directive);
    const changed = this.#model === undefined || !sameDirective(this.#model.directive, normalized);
    this.#model = Object.freeze({
      directive: normalized,
      owner: withOrder(owner, options),
      ...(options?.reason === undefined ? {} : { reason: validateReason(options.reason) }),
    });
    this.#mutations.push({ changed, reason: options?.reason });
  }

  clearModel(options?: Omit<PromptPrefixMutationOptions, "order">): void {
    const changed = this.#model !== undefined;
    this.#model = undefined;
    this.#mutations.push({ changed, reason: options?.reason });
  }

  hasUnreasonedChange(): boolean {
    return this.#mutations.some((mutation) => mutation.changed && mutation.reason === undefined);
  }

  snapshot(): PromptPrefixSnapshot {
    const instructions = [...this.#instructions.values()].sort(compareSlots).flatMap((slot) =>
      slot.items.map((text) =>
        Object.freeze({
          text,
          digest: digest(text),
          contributor: contributor(slot.owner, slot.reason),
        }),
      ),
    );
    const allTools = [...this.#tools.values()]
      .sort(compareSlots)
      .flatMap((slot) =>
        slot.tools.map((tool) =>
          Object.freeze({ tool, contributor: contributor(slot.owner, slot.reason) }),
        ),
      );
    const duplicate = new Set<string>();
    const seen = new Set<string>();
    for (const item of allTools) {
      if (seen.has(item.tool.name)) duplicate.add(item.tool.name);
      seen.add(item.tool.name);
    }
    if (duplicate.size) throw new Error(`Duplicate Tool '${[...duplicate].sort().join("', '")}'`);
    const tools = allTools.filter((item) => !this.#withheld.has(item.tool.name));
    const toolContracts = tools.map(({ tool, contributor: source }) => toolContract(tool, source));
    const contributors = Object.freeze([
      ...[...this.#instructions.values()]
        .sort(compareSlots)
        .map((slot) => contributor(slot.owner, slot.reason)),
      ...[...this.#tools.values()]
        .sort(compareSlots)
        .map((slot) => contributor(slot.owner, slot.reason)),
      ...(this.#model?.owner ? [contributor(this.#model.owner, this.#model.reason)] : []),
    ]);
    const model = this.#model?.directive;
    const logical = digest({
      instructions: instructions.map((item) => item.text),
      tools: toolContracts.map((tool) => ({
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        inputSchema: tool.inputSchema,
      })),
    });
    const modelDigest = digest(model ?? null);
    return Object.freeze({
      version: 1,
      ...(model === undefined ? {} : { model }),
      instructions: Object.freeze(instructions),
      tools: Object.freeze(tools.map((item) => item.tool)),
      toolContracts: Object.freeze(toolContracts),
      withheldTools: Object.freeze([...this.#withheld.keys()].sort()),
      contributors,
      digests: Object.freeze({
        logical,
        model: modelDigest,
        request: digest({ logical, model: modelDigest }),
      }),
    });
  }

  state(snapshot: PromptPrefixSnapshot): State {
    return Object.freeze({
      instructions: new Map(this.#instructions),
      tools: new Map(this.#tools),
      withheld: new Map(this.#withheld),
      ...(this.#model === undefined ? {} : { model: this.#model }),
      snapshot,
    });
  }

  catalogByName(): ReadonlyMap<string, BoundToolDefinition> {
    return new Map(
      [...this.#tools.values()].flatMap((slot) =>
        slot.tools.map((tool) => [tool.name, tool] as const),
      ),
    );
  }

  isWithheld(name: string): boolean {
    return this.#withheld.has(name);
  }
}

export function owner(middlewareId: string, middlewareOrder: number, slot: string): Owner {
  return Object.freeze({ middlewareId, middlewareOrder, slot, order: 0 });
}

/** Detects a lower-level mutation that would make the logical header dishonest. */
export function assertCanonicalPrefix(snapshot: PromptPrefixSnapshot): void {
  const contracts = snapshot.tools.map((tool, index) => {
    const value = providerTool(tool);
    const recorded = snapshot.toolContracts[index];
    if (recorded === undefined || recorded.digest !== digest(value))
      throw new Error("Prompt prefix tool contract differs from its bound tool");
    return value;
  });
  const logical = digest({
    instructions: snapshot.instructions.map((item) => item.text),
    tools: contracts,
  });
  const model = digest(snapshot.model ?? null);
  const request = digest({ logical, model });
  if (
    snapshot.digests.logical !== logical ||
    snapshot.digests.model !== model ||
    snapshot.digests.request !== request
  )
    throw new Error("Prompt prefix digests do not match its canonical logical content");
}

function seededState(directive?: ModelDirective): State {
  return Object.freeze({
    instructions: new Map(),
    tools: new Map(),
    withheld: new Map(),
    ...(directive === undefined ? {} : { model: Object.freeze({ directive }) }),
  });
}
function slotKey(value: Owner): string {
  return `${value.middlewareId}\u0000${value.slot}`;
}
function validateSlot(value: string): void {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("Prompt prefix slot must be a non-empty string");
}
function validateToolName(value: string): void {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("Tool name must be a non-empty string");
}
function validateReason(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new TypeError("Prompt prefix mutation reason must be a non-empty string");
  return value;
}
function checkedDirective(value: ModelDirective): ModelDirective {
  const normalized = normalizeDirective(value);
  if (normalized instanceof Error) throw normalized;
  return normalized;
}
function withOrder(
  base: Owner,
  options?: PromptPrefixMutationOptions,
  previousOrder?: number,
): Owner {
  const order = options?.order ?? previousOrder ?? 0;
  if (!Number.isFinite(order)) throw new TypeError("Prompt prefix order must be a finite number");
  return Object.freeze({ ...base, order });
}
function compareSlots(left: { readonly owner: Owner }, right: { readonly owner: Owner }): number {
  return (
    left.owner.order - right.owner.order ||
    left.owner.middlewareOrder - right.owner.middlewareOrder ||
    left.owner.slot.localeCompare(right.owner.slot)
  );
}
function sameOwner(left: Owner, right: Owner): boolean {
  return (
    left.middlewareId === right.middlewareId &&
    left.middlewareOrder === right.middlewareOrder &&
    left.slot === right.slot &&
    left.order === right.order
  );
}
function sameInstructionSlot(left: InstructionSlot | undefined, right: InstructionSlot): boolean {
  return (
    left !== undefined &&
    sameOwner(left.owner, right.owner) &&
    digest(left.items) === digest(right.items)
  );
}
function sameToolSlot(left: ToolSlot | undefined, right: ToolSlot): boolean {
  return (
    left !== undefined &&
    sameOwner(left.owner, right.owner) &&
    digest(left.tools.map(providerTool)) === digest(right.tools.map(providerTool))
  );
}
function contributor(value: Owner, reason?: string): PromptPrefixContributor {
  return Object.freeze({
    middlewareId: value.middlewareId,
    slot: value.slot,
    order: value.order,
    digest: digest({ middlewareId: value.middlewareId, slot: value.slot, order: value.order }),
    ...(reason === undefined ? {} : { reason }),
  });
}
function providerTool(tool: BoundToolDefinition): object {
  return {
    name: tool.name,
    ...(tool.description === undefined ? {} : { description: tool.description }),
    inputSchema: copyJson(tool.input.jsonSchema),
  };
}
function toolContract(
  tool: BoundToolDefinition,
  source: PromptPrefixContributor,
): PromptPrefixTool {
  const value = providerTool(tool) as {
    name: string;
    description?: string;
    inputSchema: import("../types/shared.js").JsonObject;
  };
  return Object.freeze({ ...value, digest: digest(value), contributor: source });
}
