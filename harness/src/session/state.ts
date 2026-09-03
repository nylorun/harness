import type {
  ActiveExecutionRecord,
  InputEvent,
  SessionSnapshot,
  TranscriptEntry,
} from "../types/session.js";
import type { ModelCandidate } from "../types/model.js";
import type { RequiredInteraction, ToolResult } from "../types/tool.js";

export function initialState(
  id: string,
  input: {
    readonly turnCount?: number;
    readonly revision?: number;
    readonly transcript?: readonly TranscriptEntry[];
  } = {},
): SessionSnapshot {
  return Object.freeze({
    id,
    status: "idle",
    turnCount: input.turnCount ?? 0,
    revision: input.revision ?? 0,
    transcript: Object.freeze([...(input.transcript ?? [])]),
  });
}

export function withStatus(
  state: SessionSnapshot,
  status: SessionSnapshot["status"],
  pendingInteraction?: RequiredInteraction,
  active?: ActiveExecutionRecord,
): SessionSnapshot {
  return Object.freeze({
    id: state.id,
    status,
    turnCount: state.turnCount,
    revision: state.revision,
    transcript: state.transcript,
    ...(pendingInteraction ? { pendingInteraction } : {}),
    ...(active ? { active } : {}),
  });
}

export function withRevision(state: SessionSnapshot, revision: number): SessionSnapshot {
  return Object.freeze({ ...state, revision });
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
    turnCount: state.turnCount + 1,
    revision: state.revision,
    transcript: Object.freeze(transcript),
  });
}

function append(state: SessionSnapshot, entry: TranscriptEntry): SessionSnapshot {
  return Object.freeze({
    ...state,
    transcript: Object.freeze([...state.transcript, Object.freeze(entry)]),
  });
}

export const commitInput = (
  state: SessionSnapshot,
  turnId: string,
  event: InputEvent,
): SessionSnapshot => append(state, { kind: "input", turnId, event: Object.freeze({ ...event }) });

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
  output: import("../types/shared.js").JsonValue,
): SessionSnapshot => append(state, { kind: "final", turnId, stepId, output });
