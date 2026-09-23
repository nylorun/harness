import type { LiveEvent } from "@nylorun/agents/client";

/** Studio row: Runtime LiveEvent plus delivery provenance. */
export type StudioEvent = LiveEvent &
  Readonly<{
    /** History `/items` load vs live SSE `/events` observation. */
    committed: boolean;
  }>;

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}

function compact(value: unknown): string {
  if (typeof value === "string")
    return value.length > 140 ? `${value.slice(0, 137)}…` : value;
  try {
    const result = JSON.stringify(value);
    if (result === undefined) return "—";
    return result.length > 140 ? `${result.slice(0, 137)}…` : result;
  } catch {
    return "Result is not serializable.";
  }
}

const LABELS: Readonly<Record<string, string>> = {
  "command.message": "Message",
  "command.cancel": "Cancel",
  "command.approve": "Approve",
  "command.respond": "Respond",
  "command.action_result": "Action result",
  "turn.completed": "Turn completed",
  "turn.waiting": "Turn waiting",
  "turn.uncertain": "Turn uncertain",
  "turn.failed": "Turn failed",
  "turn.cancelled": "Turn cancelled",
  "turn.runnable": "Turn runnable",
  "action.pending": "Action pending",
  "action.claimed": "Action claimed",
  "action.completed": "Action completed",
  "action.uncertain": "Action uncertain",
  "effect.uncertain": "Effect uncertain",
};

/** Names what an action runs: `Hook · before step (a, b)` or `Tool · name`. */
export function actionLabel(payload: Readonly<Record<string, unknown>>): string {
  const hook = payload.hook as
    | { at?: unknown; scope?: unknown; capabilityIds?: unknown }
    | undefined;
  if (hook && typeof hook === "object") {
    const ids = Array.isArray(hook.capabilityIds) ? hook.capabilityIds.join(", ") : "";
    return `Hook · ${String(hook.at)} ${String(hook.scope)}${ids ? ` (${ids})` : ""}`;
  }
  return `Tool · ${text(payload.toolName, text(payload.actionId, "action"))}`;
}

export function eventLabel(event: Pick<LiveEvent, "type">): string {
  return LABELS[event.type] ?? event.type.replaceAll(".", " ");
}

export function eventSummary(event: Pick<LiveEvent, "type" | "payload">): string {
  const payload = record(event.payload);
  switch (event.type) {
    case "command.message":
      return compact(payload.content);
    case "command.cancel":
      return text(payload.reason, "Cancel requested.");
    case "command.approve":
      return payload.approved === true ? "Approved." : "Denied.";
    case "command.respond":
      return compact(payload.value);
    case "command.action_result":
      return text(payload.actionId, "Action result submitted.");
    case "turn.completed":
      return compact(payload.output);
    case "turn.failed":
      return text(payload.message, "The turn failed.");
    case "turn.cancelled":
      return text(payload.reason, "Turn cancelled.");
    case "turn.waiting":
    case "turn.uncertain":
    case "turn.runnable":
      return compact(payload.waits ?? payload);
    case "action.pending":
    case "action.claimed":
    case "action.completed":
    case "action.uncertain": {
      const name = actionLabel(payload);
      if (event.type === "action.pending")
        return `${name}: ${compact(payload.input)}`;
      if (event.type === "action.completed")
        return `${name}: ${compact(payload.result ?? payload.outcome)}`;
      return name;
    }
    case "effect.uncertain":
      return text(
        payload.message,
        text(payload.effectId, "Effect became uncertain."),
      );
    default:
      return compact(event.payload);
  }
}

export function mergeStudioEvents(
  current: readonly StudioEvent[],
  incoming: readonly StudioEvent[],
): readonly StudioEvent[] {
  const byId = new Map(current.map((event) => [event.eventId, event]));
  for (const event of incoming) {
    const prior = byId.get(event.eventId);
    byId.set(event.eventId, {
      ...event,
      committed: event.committed || prior?.committed === true,
    });
  }
  return [...byId.values()].sort((a, b) =>
    a.createdAt === b.createdAt
      ? a.cursor.localeCompare(b.cursor)
      : a.createdAt < b.createdAt
        ? 1
        : -1,
  );
}
