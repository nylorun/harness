import assert from "node:assert/strict";
import test from "node:test";
import { liveStatusFromEvents, statusColor } from "../web/src/workflow/live-status.ts";

/** Recorded seam fixtures — Runtime may not emit all yet. */
const fixtures = [
  {
    type: "node.started",
    payload: { path: "ship-feature", kind: "chain", key: "ship-feature" },
  },
  {
    type: "node.started",
    payload: {
      path: "ship-feature/planner",
      kind: "agent",
      key: "ship-feature/planner",
    },
  },
  {
    type: "node.agent",
    payload: {
      path: "ship-feature/planner",
      sessionId: "agent-sess-planner",
      turnId: "t1",
    },
  },
  {
    type: "node.completed",
    payload: { path: "ship-feature/planner" },
  },
  {
    type: "map.items",
    payload: { path: "ship-feature/implement", count: 3 },
  },
  {
    type: "loop.iteration",
    payload: {
      path: "ship-feature/implement/code",
      n: 2,
      sessionId: "agent-sess-coder",
      turnId: "t2",
    },
  },
  {
    type: "switch.selected",
    payload: { path: "route", case: "bug" },
  },
  {
    type: "node.failed",
    payload: {
      path: "ship-feature/open-pr",
      error: { code: "tool.failed", message: "PR API down" },
    },
  },
];

test("WF-EV9: liveStatusFromEvents colours nodes from seam fixtures", () => {
  const live = liveStatusFromEvents(fixtures);
  assert.equal(live.get("ship-feature/planner")?.status, "completed");
  assert.equal(
    live.get("ship-feature/planner")?.agentSessionId,
    "agent-sess-planner",
  );
  assert.equal(live.get("ship-feature/implement")?.mapCount, 3);
  assert.equal(live.get("ship-feature/implement/code")?.iteration, 2);
  assert.equal(live.get("ship-feature/implement/code")?.status, "running");
  assert.equal(live.get("route")?.selectedCase, "bug");
  assert.equal(live.get("route/bug")?.status, "selected");
  assert.equal(live.get("ship-feature/open-pr")?.status, "failed");
  assert.equal(live.get("ship-feature/open-pr")?.error?.code, "tool.failed");
});

test("statusColor maps each run status", () => {
  assert.match(statusColor("running"), /#|var\(/);
  assert.match(statusColor("failed"), /#|var\(/);
  assert.match(statusColor("idle"), /#|var\(/);
});
