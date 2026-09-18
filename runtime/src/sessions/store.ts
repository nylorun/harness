import type { ExecutionInput, ExecutionState } from "@nylorun/harness";

export interface CanonicalEvent {
  readonly session: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
}
export interface SessionSummary {
  readonly session: string;
  readonly title?: string;
  readonly status: StoredSession["status"];
  readonly startedAt: number;
  readonly endedAt?: number;
}
export interface StoredSession {
  readonly version: 1;
  readonly id: string;
  readonly agentId: string;
  readonly state?: ExecutionState;
  readonly status:
    | "running"
    | "waiting"
    | "completed"
    | "cancelled"
    | "failed"
    | "interrupted"
    | "archived";
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly title?: string;
  readonly active?: { readonly runId: string; readonly input: ExecutionInput };
  readonly events: readonly CanonicalEvent[];
}
export interface SessionStore {
  get(agentId: string, sessionId: string): Promise<StoredSession | undefined>;
  put(
    agentId: string,
    sessionId: string,
    session: StoredSession,
  ): Promise<void>;
  list(agentId: string): Promise<readonly SessionSummary[]>;
}
export interface ManagedSessionStore extends SessionStore {
  close(): Promise<void>;
}

export function sessionSummary(session: StoredSession): SessionSummary {
  return {
    session: session.id,
    status: session.status,
    startedAt: session.startedAt,
    ...(session.title === undefined ? {} : { title: session.title }),
    ...(session.status === "completed" ? { endedAt: session.updatedAt } : {}),
  };
}

export function memorySessions(): SessionStore {
  const documents = new Map<string, StoredSession>();
  const key = (agentId: string, sessionId: string) =>
    JSON.stringify([agentId, sessionId]);
  return {
    async get(agentId, sessionId) {
      const found = documents.get(key(agentId, sessionId));
      return found === undefined ? undefined : structuredClone(found);
    },
    async put(agentId, sessionId, session) {
      if (session.id !== sessionId || session.agentId !== agentId)
        throw new Error("Session identity mismatch");
      documents.set(key(agentId, sessionId), structuredClone(session));
    },
    async list(agentId) {
      return [...documents.values()]
        .filter((session) => session.agentId === agentId)
        .map(sessionSummary)
        .sort((a, b) => b.startedAt - a.startedAt);
    },
  };
}
