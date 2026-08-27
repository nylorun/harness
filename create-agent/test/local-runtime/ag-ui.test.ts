import { describe, expect, it } from "vitest";
import type { WireSessionEvent } from "../../src/local/runtime/index.js";
import { agUiEvents } from "../../src/local/runtime/runtime/ag-ui.js";

describe("AG-UI event projection", () => {
  it("ends an error stream with RUN_ERROR only", () => {
    const events: WireSessionEvent[] = [{
      session: "session-1", seq: 1, ts: "2026-08-21T00:00:00.000Z", type: "error",
      payload: { code: "model_unavailable", message: "The model is unavailable." }
    }];
    expect([...agUiEvents(events, "session-1", "run-1")].map((event) => event.type)).toEqual(["RUN_STARTED", "RUN_ERROR"]);
  });
});
