import type { RuntimeSessionState, RuntimeSessionStatus, WireSessionEvent } from "./contracts.js";

export type SessionRecord = Readonly<{
  id: string;
  status: RuntimeSessionStatus;
  startedAt: number;
  endedAt?: number;
  /** Present only when the caller supplied one on a detached start. */
  idempotencyKey?: string;
}>;

/**
 * Where a session's identity resolves.
 *
 * This is a seam rather than a field on the agent, and that is load-bearing: the Agent Runtime
 * holds no cross-session state, which is what lets it scale to zero without forfeiting a durability
 * guarantee. Locally the implementation is a map that dies with the process; hosted it is durable.
 * Cancelling a session you did not start needs one of them either way, because a caller holding
 * nothing but an id has nowhere else to look.
 *
 * Internal at this phase — not exported from the package barrel, and carrying no compatibility
 * commitment, until a builder needs to supply her own.
 */
export type SessionStore = Readonly<{
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | undefined>;
  list(): Promise<readonly SessionRecord[]>;
  settle(id: string, status: RuntimeSessionStatus): Promise<void>;
  /** Updates a live session without manufacturing a terminal timestamp. */
  setStatus(id: string, status: RuntimeSessionStatus): Promise<void>;
  /** Returns the id a previous start claimed under this key, so a retry is not a second session. */
  claim(key: string, id: string): Promise<string>;
}>;

/**
 * What only the process that started a session can hold: the handle that stops it, and the events
 * seen so far. Neither survives a restart, which is why they sit beside the store rather than in it
 * — a durable store would still not make a dead process's abort function callable.
 */
export type LiveSession = Readonly<{
  abort(reason: string): void;
  send(input: string): boolean;
  /**
   * Every event the session has emitted, kept for the life of the process rather than discarded
   * when the session settles — a client that reconnects a moment late still gets the whole stream.
   * Nothing here survives the process, which is what record persistence would later add.
   */
  events: WireSessionEvent[];
  /** Folded state after the latest event, retained for the next serial turn. */
  state(): RuntimeSessionState;
  /** Resolves when the session settles, so a late reader can await rather than poll. */
  settled: Promise<void>;
  /** False once no further events can arrive, which is how a reader knows to stop waiting. */
  running(): boolean;
  wake(): void;
  waiters: Set<() => void>;
}>;

export function createMemorySessionStore(): SessionStore {
  const records = new Map<string, SessionRecord>();
  const claims = new Map<string, string>();

  return Object.freeze({
    async create(record) {
      records.set(record.id, record);
    },
    async get(id) {
      return records.get(id);
    },
    async list() {
      return Object.freeze([...records.values()]);
    },
    async settle(id, status) {
      const found = records.get(id);
      if (found === undefined) return;
      records.set(id, Object.freeze({ ...found, status, endedAt: Date.now() }));
    },
    async setStatus(id, status) {
      const found = records.get(id);
      if (found === undefined) return;
      records.set(id, Object.freeze({ ...found, status }));
    },
    async claim(key, id) {
      const existing = claims.get(key);
      if (existing !== undefined) return existing;
      claims.set(key, id);
      return id;
    }
  });
}
