import type { SessionEvent, SessionState, ToolCall, TranscriptEntry } from "./types.js";

export function initialState(session: string): SessionState {
  return {
    session,
    status: "requested",
    seq: 0,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    turns: 0,
    transcript: []
  };
}

function number(payload: Readonly<Record<string, unknown>>, key: string): number {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function fold(state: SessionState, event: SessionEvent): SessionState {
  if (event.session !== state.session) throw new Error("Cannot fold an event from a different session");
  if (event.seq !== state.seq + 1) throw new Error(`Expected event sequence ${state.seq + 1}, received ${event.seq}`);

  let transcript = state.transcript;
  if (event.type === "session.started" && typeof event.payload.input === "string") {
    transcript = [...transcript, { kind: "input", content: event.payload.input }];
  } else if (event.type === "model.call") {
    const content = typeof event.payload.content === "string" ? event.payload.content : "";
    const rawCalls = Array.isArray(event.payload.tool_calls) ? event.payload.tool_calls : [];
    const toolCalls = rawCalls.filter(isToolCall);
    transcript = [...transcript, { kind: "assistant", content, toolCalls } satisfies TranscriptEntry];
  } else if (event.type === "tool.call") {
    const toolCallId = typeof event.payload.tool_call_id === "string" ? event.payload.tool_call_id : "unknown";
    const content = typeof event.payload.model_result === "string" ? event.payload.model_result : "";
    transcript = [...transcript, { kind: "tool", toolCallId, content } satisfies TranscriptEntry];
  }

  const terminal = event.type === "session.ended";
  const failed = terminal && event.payload.state === "failed";
  const status =
    terminal
      ? failed
        ? "failed"
        : "completed"
      : event.type === "session.started"
        ? "starting"
        : event.type === "session.interrupted"
          ? "paused"
          : event.type === "session.episode.ended"
            ? state.status
            : "running";
  return {
    ...state,
    seq: event.seq,
    status,
    ...(event.type === "session.started" ? { startedAt: event.ts } : {}),
    ...(terminal ? { endedAt: event.ts, exitReason: event.payload.exit_reason as SessionState["exitReason"] } : {}),
    tokensIn: state.tokensIn + (event.type === "model.call" ? number(event.payload, "tokens_in") : 0),
    tokensOut: state.tokensOut + (event.type === "model.call" ? number(event.payload, "tokens_out") : 0),
    costUsd: state.costUsd + (event.type === "model.call" ? number(event.payload, "cost_usd") : 0),
    turns: state.turns + (event.type === "model.call" ? 1 : 0),
    transcript
  };
}

function isToolCall(value: unknown): value is ToolCall {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.arguments === "string"
  );
}

export function rehydrate(events: readonly SessionEvent[]): SessionState {
  if (events.length === 0) throw new Error("At least one event is required to rehydrate a session");
  return events.reduce(fold, initialState(events[0]!.session));
}
