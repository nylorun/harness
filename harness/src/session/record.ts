import type { ActiveExecutionRecord, SessionRecord, SessionSnapshot } from "../types/session.js";
import type { JsonObject } from "../types/shared.js";
import { copyJson } from "../utils/immutable.js";

export function sessionRecord(input: {
  readonly state: SessionSnapshot;
  readonly transition: SessionRecord["transition"];
  readonly session: Readonly<{ readonly userId?: string; readonly context?: JsonObject }>;
  readonly active?: ActiveExecutionRecord;
}): SessionRecord {
  const value = {
    version: 1 as const,
    revision: input.state.revision,
    transition: input.transition,
    session: {
      id: input.state.id,
      ...(input.session.userId === undefined ? {} : { userId: input.session.userId }),
      ...(input.session.context === undefined ? {} : { context: copyJson(input.session.context) }),
      turnCount: input.state.turnCount,
      status: input.state.status,
    },
    transcript: copyJson(input.state.transcript),
    ...(input.active === undefined ? {} : { active: copyJson(input.active) }),
  };
  return deepFreeze(value) as SessionRecord;
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
  return Object.freeze(value);
}
