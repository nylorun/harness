import assert from "node:assert/strict";
import test from "node:test";
import { summarizeManifestPatch } from "../web/src/workflow/manifest-diff.ts";
import {
  groupIterationsByPath,
  iterationTimelineFromEvents,
} from "../web/src/workflow/iteration-timeline.ts";

/** Recorded loop.* fixtures (loops.md §4.6). */
const fixtures = [
  {
    type: "loop.iteration",
    payload: {
      path: "fix-tests",
      n: 1,
      sessionId: "s-coder",
      turnId: "t1",
      manifestHash: "hash-a",
    },
  },
  {
    type: "loop.verified",
    payload: {
      path: "fix-tests",
      n: 1,
      pass: false,
      feedback: "try again",
    },
  },
  {
    type: "loop.decided",
    payload: { path: "fix-tests", n: 1, next: "input", patched: true },
  },
  {
    type: "loop.iteration",
    payload: {
      path: "fix-tests",
      n: 2,
      sessionId: "s-coder",
      turnId: "t2",
      manifestHash: "hash-b",
    },
  },
  {
    type: "loop.verified",
    payload: { path: "fix-tests", n: 2, pass: true },
  },
  {
    type: "loop.decided",
    payload: { path: "fix-tests", n: 2, next: "output", patched: false },
  },
];

const before = {
  id: "coder",
  capabilities: [
    {
      id: "main",
      instructions: "Write code",
      tools: [{ name: "edit" }, { name: "deploy" }],
    },
  ],
};

const after = {
  id: "coder",
  capabilities: [
    {
      id: "main",
      instructions: "Write code",
      // decide removed deploy and added a follow-up instruction via withInstructions
      tools: [{ name: "edit" }],
    },
    { id: "extra", instructions: "Run the test suite yourself before answering." },
  ],
};

test("LOOP-EV5: iteration timeline keeps count and decide outcomes", () => {
  const rows = iterationTimelineFromEvents(fixtures);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.n, 1);
  assert.equal(rows[0]?.pass, false);
  assert.equal(rows[0]?.decided, "input");
  assert.equal(rows[0]?.patched, true);
  assert.equal(rows[0]?.patchSummary, "manifest patched");
  assert.equal(rows[1]?.n, 2);
  assert.equal(rows[1]?.decided, "output");
  assert.equal(rows[1]?.pass, true);
  const groups = groupIterationsByPath(rows);
  assert.equal(groups.get("fix-tests")?.length, 2);
});

test("LOOP-EV5: patched decide shows difference from previous iteration", () => {
  const manifests = new Map([
    [1, before],
    [2, after],
  ]);
  const rows = iterationTimelineFromEvents(fixtures, {
    manifestsByIteration: manifests,
  });
  assert.match(rows[0]?.patchSummary ?? "", /instructions \+1/);
  assert.match(rows[0]?.patchSummary ?? "", /tool `deploy` removed/);
});

test("summarizeManifestPatch matches design example phrasing", () => {
  const summary = summarizeManifestPatch(before, after);
  assert.equal(summary, "instructions +1, tool `deploy` removed");
});
