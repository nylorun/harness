import type { InputEvent, SessionSnapshot, TranscriptEntry } from "../types/session.js";
import type { ModelCandidate } from "../types/model.js";
import type { RequiredInteraction, ToolResult } from "../types/tool.js";

export function initialState(id: string): SessionSnapshot {
  return Object.freeze({ id, status: "idle", turnCount: 0, transcript: Object.freeze([]) });
}

export function withStatus(
  state: SessionSnapshot,
  status: SessionSnapshot["status"],
  pendingInteraction?: RequiredInteraction,
): SessionSnapshot {
  return Object.freeze({
    id: state.id,
    status,
    turnCount: state.turnCount,
    transcript: state.transcript,
    ...(pendingInteraction ? { pendingInteraction } : {}),
  });
}

export function beginTurn(
  state: SessionSnapshot,
  turnId: string,
  event?: InputEvent,
): SessionSnapshot {
  const transcript = event
    ? [
        ...state.transcript,
        Object.freeze({ kind: "input" as const, turnId, event: Object.freeze({ ...event }) }),
      ]
    : [...state.transcript];
  return Object.freeze({
    id: state.id,
    status: "running",
    turnCount: state.turnCount + (event ? 1 : 0),
    transcript: Object.freeze(transcript),
  });
}

function append(state: SessionSnapshot, entry: TranscriptEntry): SessionSnapshot {
  return Object.freeze({
    ...state,
    transcript: Object.freeze([...state.transcript, Object.freeze(entry)]),
  });
}

export const commitCandidate = (
  state: SessionSnapshot,
  turnId: string,
  stepId: string,
  candidate: ModelCandidate,
): SessionSnapshot => append(state, { kind: "candidate", turnId, stepId, candidate });

export const commitToolResults = (
  state: SessionSnapshot,
  turnId: string,
  stepId: string,
  results: readonly ToolResult[],
): SessionSnapshot =>
  append(state, { kind: "tool-results", turnId, stepId, results: Object.freeze([...results]) });

export const commitFinal = (
  state: SessionSnapshot,
  turnId: string,
  stepId: string,
  output: string,
): SessionSnapshot => append(state, { kind: "final", turnId, stepId, output });
