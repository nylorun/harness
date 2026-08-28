import type {
  ContextContributor,
  ContextLifetime,
  ContextMutationOptions,
  ContextSnapshot,
} from "../types/model.js";
import type { ContextItem, JsonObject, JsonValue } from "../types/shared.js";
import { HarnessError } from "../errors.js";
import { digest } from "../utils/digest.js";
import { copyJson } from "../utils/immutable.js";

export const HOST_CONTEXT_MIDDLEWARE_ID = "host";
export const HOST_CONTEXT_SLOT = "session";

const HOST_KEY = "\u0000host";
const CONTEXT_TYPE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const LIFETIMES = new Set<ContextLifetime>(["step", "turn", "session"]);

interface Owner {
  readonly middlewareId: string;
  readonly middlewareOrder: number;
  readonly slot: string;
  readonly order: number;
}

interface ContextSlot {
  readonly owner: Owner;
  readonly items: readonly ContextItem[];
  readonly lifetime: ContextLifetime;
  readonly reason?: string;
}

interface State {
  readonly slots: ReadonlyMap<string, ContextSlot>;
  readonly snapshot?: ContextSnapshot;
}

export function contextOwner(middlewareId: string, middlewareOrder: number, slot: string): Owner {
  return Object.freeze({ middlewareId, middlewareOrder, slot, order: 0 });
}

/** Scheduler-scoped context ledger. Writes land only through a named transaction. */
export class ContextState {
  #state: State;

  constructor(hostContext?: JsonObject) {
    this.#state = seededState(hostContext);
  }

  /** Drop turn-lifetime slots from committed state. Call when a new user turn starts. */
  expireTurn(): void {
    const slots = new Map(this.#state.slots);
    for (const [key, slot] of slots) if (slot.lifetime === "turn") slots.delete(key);
    this.#state = Object.freeze({ slots });
  }

  begin(): ContextTransaction {
    return new ContextTransaction(this.#state);
  }

  commit(transaction: ContextTransaction, snapshot: ContextSnapshot): void {
    this.#state = transaction.state(snapshot);
  }
}

export class ContextTransaction {
  #slots: Map<string, ContextSlot>;

  constructor(previous: State) {
    this.#slots = new Map();
    for (const [key, slot] of previous.slots) {
      if (slot.lifetime !== "step") this.#slots.set(key, slot);
    }
  }

  set(owner: Owner, items: readonly ContextItem[], options?: ContextMutationOptions): void {
    rejectHostMutation(owner);
    validateSlot(owner.slot);
    if (!Array.isArray(items))
      throw new HarnessError("context.invalid-item", "Step context items must be an array");
    const lifetime = options?.lifetime ?? "step";
    if (!LIFETIMES.has(lifetime))
      throw new HarnessError(
        "context.invalid-lifetime",
        "Context lifetime must be step, turn, or session",
      );
    const key = slotKey(owner);
    const prior = this.#slots.get(key);
    const entry = Object.freeze({
      owner: withOrder(owner, options, prior?.owner.order),
      items: Object.freeze(items.map(normalizeItem)),
      lifetime,
      ...(options?.reason === undefined ? {} : { reason: validateReason(options.reason) }),
    });
    this.#slots.set(key, entry);
  }

  remove(owner: Owner, options?: Omit<ContextMutationOptions, "order" | "lifetime">): void {
    rejectHostMutation(owner);
    validateSlot(owner.slot);
    if (options?.reason !== undefined) validateReason(options.reason);
    this.#slots.delete(slotKey(owner));
  }

  snapshot(): ContextSnapshot {
    const slots = [...this.#slots.values()].sort(compareSlots);
    const items = slots.flatMap((slot) => slot.items);
    const contributors = Object.freeze(slots.map((slot) => contributor(slot)));
    return Object.freeze({
      items: Object.freeze([...items]),
      contributors,
      digest: digest(items.map(itemDigest)),
    });
  }

  state(snapshot: ContextSnapshot): State {
    return Object.freeze({
      slots: new Map(this.#slots),
      snapshot,
    });
  }
}

function seededState(hostContext?: JsonObject): State {
  const slots = new Map<string, ContextSlot>();
  if (hostContext !== undefined) {
    slots.set(
      HOST_KEY,
      Object.freeze({
        owner: Object.freeze({
          middlewareId: HOST_CONTEXT_MIDDLEWARE_ID,
          middlewareOrder: -1,
          slot: HOST_CONTEXT_SLOT,
          order: 0,
        }),
        items: Object.freeze([{ type: "session" as const, value: copyJson(hostContext) }]),
        lifetime: "session" as const,
      }),
    );
  }
  return Object.freeze({ slots });
}

function normalizeItem(item: ContextItem): ContextItem {
  if (!item || typeof item !== "object")
    throw new HarnessError("context.invalid-item", "Step context items must be objects");
  if (item.type !== undefined) {
    if (typeof item.type !== "string" || !CONTEXT_TYPE.test(item.type))
      throw new HarnessError(
        "context.invalid-item-type",
        "Step context item type must match [A-Za-z][A-Za-z0-9_-]{0,63}",
      );
  }
  return Object.freeze({
    ...(item.type === undefined ? {} : { type: item.type }),
    value: copyJson(item.value) as JsonValue,
  });
}

function rejectHostMutation(owner: Owner): void {
  if (owner.middlewareId === HOST_CONTEXT_MIDDLEWARE_ID && owner.slot === HOST_CONTEXT_SLOT)
    throw new HarnessError("context.invalid-slot", "Host session context cannot be replaced");
}

function slotKey(value: Owner): string {
  return `${value.middlewareId}\u0000${value.slot}`;
}

function validateSlot(value: string): void {
  if (typeof value !== "string" || value.length === 0)
    throw new HarnessError("context.invalid-slot", "Context slot must be a non-empty string");
}

function validateReason(value: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new HarnessError(
      "context.invalid-reason",
      "Context mutation reason must be a non-empty string",
    );
  return value;
}

function withOrder(base: Owner, options?: ContextMutationOptions, previousOrder?: number): Owner {
  const order = options?.order ?? previousOrder ?? 0;
  if (!Number.isFinite(order))
    throw new HarnessError("context.invalid-order", "Context order must be a finite number");
  return Object.freeze({ ...base, order });
}

function compareSlots(left: ContextSlot, right: ContextSlot): number {
  const hostLeft = isHostSlot(left);
  const hostRight = isHostSlot(right);
  if (hostLeft !== hostRight) return hostLeft ? -1 : 1;
  return (
    left.owner.order - right.owner.order ||
    left.owner.middlewareOrder - right.owner.middlewareOrder ||
    left.owner.slot.localeCompare(right.owner.slot)
  );
}

function isHostSlot(slot: ContextSlot): boolean {
  return (
    slot.owner.middlewareId === HOST_CONTEXT_MIDDLEWARE_ID && slot.owner.slot === HOST_CONTEXT_SLOT
  );
}

function contributor(slot: ContextSlot): ContextContributor {
  return Object.freeze({
    middlewareId: slot.owner.middlewareId,
    slot: slot.owner.slot,
    order: slot.owner.order,
    lifetime: slot.lifetime,
    digest: digest({
      middlewareId: slot.owner.middlewareId,
      slot: slot.owner.slot,
      order: slot.owner.order,
      lifetime: slot.lifetime,
    }),
    ...(slot.reason === undefined ? {} : { reason: slot.reason }),
  });
}

function itemDigest(item: ContextItem): object {
  return item.type === undefined ? { value: item.value } : { type: item.type, value: item.value };
}
