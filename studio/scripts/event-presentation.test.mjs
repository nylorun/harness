import assert from "node:assert/strict";
import test from "node:test";
import {
  eventLabel,
  eventSummary,
  mergeStudioEvents,
} from "../web/src/event-presentation.ts";

const base = {
  eventId: "e1",
  sessionId: "s1",
  turnId: "t1",
  cursor: "c1",
  createdAt: "2026-09-21T00:00:00.000Z",
};

test("labels new Runtime LiveEvent types", () => {
  assert.equal(eventLabel({ type: "command.message" }), "Message");
  assert.equal(eventLabel({ type: "action.pending" }), "Action pending");
  assert.equal(eventLabel({ type: "turn.completed" }), "Turn completed");
  assert.equal(eventLabel({ type: "effect.uncertain" }), "Effect uncertain");
});

test("summarizes message and action payloads", () => {
  assert.equal(
    eventSummary({
      type: "command.message",
      payload: { content: "Look up order demo-123" },
    }),
    "Look up order demo-123",
  );
  assert.match(
    eventSummary({
      type: "action.completed",
      payload: { toolName: "lookup", result: { ok: true } },
    }),
    /lookup/,
  );
});

test("mergeStudioEvents prefers committed and keeps newest first", () => {
  const older = {
    ...base,
    eventId: "a",
    cursor: "1",
    createdAt: "2026-09-21T00:00:01.000Z",
    type: "command.message",
    payload: {},
    committed: false,
  };
  const newer = {
    ...base,
    eventId: "b",
    cursor: "2",
    createdAt: "2026-09-21T00:00:02.000Z",
    type: "turn.completed",
    payload: { output: "hi" },
    committed: true,
  };
  const merged = mergeStudioEvents(
    [older],
    [
      { ...older, committed: true },
      newer,
    ],
  );
  assert.equal(merged[0]?.eventId, "b");
  assert.equal(merged.find((e) => e.eventId === "a")?.committed, true);
});
