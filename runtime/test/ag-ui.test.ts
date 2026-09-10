import { expect, it } from "vitest";
import { agUiEvents } from "../src/server/ag-ui.js";
import type { CanonicalEvent } from "../src/adapters/journal.js";

it.each([
  {
    type: "tripwire",
    payload: {
      code: "input.blocked",
      attributes: { message: "User input requested a policy override." },
    },
  },
  {
    type: "tripwire",
    payload: {
      code: "model.failed",
      attributes: { message: "Provider unavailable." },
    },
  },
  { type: "error", payload: { message: "Agent unavailable." } },
])(
  "terminates $type runs with a visible AG-UI error instead of successful completion",
  ({ type, payload }) => {
    const event: CanonicalEvent = {
      session: "s",
      seq: 1,
      ts: "2026-01-01T00:00:00Z",
      type,
      payload,
    };
    const result = agUiEvents([event], "s", "run");
    expect(result.map((e) => e.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
    expect(result[1]?.message).toBe(
      payload.attributes?.message ?? payload.message,
    );
  },
);

it("still finishes successful runs", () => {
  expect(
    agUiEvents(
      [
        {
          session: "s",
          seq: 1,
          ts: "2026-01-01T00:00:00Z",
          type: "final",
          payload: { output: "26" },
        },
      ],
      "s",
      "run",
    ).at(-1),
  ).toMatchObject({ type: "RUN_FINISHED" });
});
