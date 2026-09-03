import type {
  ContextContributor,
  ContextMutationOptions,
  ContextSnapshot,
} from "../types/model.js";
import type { ContextItem, JsonObject, JsonValue } from "../types/shared.js";
import { HarnessError } from "../errors.js";
import { copyJson } from "../utils/immutable.js";
import { SlotDraft, type SlotOwner } from "./slot-assembly.js";

const CONTEXT_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Per-step runtime-context draft. Host context is injected fresh for every call. */
export class ContextDraft {
  #slots = new SlotDraft<readonly ContextItem[]>();

  constructor(private readonly hostContext?: JsonObject) {}

  set(
    middlewareId: string,
    middlewareOrder: number,
    slot: string,
    items: readonly ContextItem[],
    options?: ContextMutationOptions,
  ): void {
    if (!Array.isArray(items))
      throw new HarnessError("context.invalid-item", "Runtime context items must be an array");
    this.#slots.set({
      middlewareId,
      middlewareOrder,
      slot,
      value: Object.freeze(items.map(normalizeItem)),
      order: options?.order,
      reason: options?.reason,
      invalidSlot: "context.invalid-slot",
      invalidOrder: "context.invalid-order",
      invalidReason: "context.invalid-reason",
      label: "Runtime context",
    });
  }

  snapshot(): ContextSnapshot {
    const slots = this.#slots.values();
    const host =
      this.hostContext === undefined
        ? []
        : [Object.freeze({ type: "session" as const, value: copyJson(this.hostContext) })];
    const items = Object.freeze([...host, ...slots.flatMap((slot) => slot.value)]);
    const contributors = Object.freeze([
      ...(this.hostContext === undefined ? [] : [hostContributor()]),
      ...slots.map((slot) => contributor(slot.owner, slot.reason)),
    ]);
    return Object.freeze({ items, contributors });
  }
}

function normalizeItem(item: ContextItem): ContextItem {
  if (!item || typeof item !== "object")
    throw new HarnessError("context.invalid-item", "Runtime context items must be objects");
  if (item.type !== undefined && (typeof item.type !== "string" || !CONTEXT_TYPE.test(item.type)))
    throw new HarnessError(
      "context.invalid-item-type",
      "Runtime context item type must match [A-Za-z][A-Za-z0-9_-]{0,63}",
    );
  return Object.freeze({
    ...(item.type === undefined ? {} : { type: item.type }),
    value: copyJson(item.value) as JsonValue,
  });
}

function hostContributor(): ContextContributor {
  return Object.freeze({
    middlewareId: "host",
    slot: "session",
    order: 0,
  });
}

function contributor(owner: SlotOwner, reason?: string): ContextContributor {
  return Object.freeze({
    middlewareId: owner.middlewareId,
    slot: owner.slot,
    order: owner.order,
    ...(reason === undefined ? {} : { reason }),
  });
}
