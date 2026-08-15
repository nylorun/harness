import { describe, expect, it } from "vitest";

import { SESSION_EVENT_TYPES } from "../src/session/index.js";

describe("public session event contract", () => {
  it("changes only through an intentional contract snapshot update", () => {
    expect(SESSION_EVENT_TYPES).toMatchInlineSnapshot(`
      [
        "session.started",
        "session.episode.started",
        "session.episode.ended",
        "session.interrupted",
        "session.resumed",
        "model.call",
        "harness.message",
        "tool.call.started",
        "tool.call",
        "skill.invocation",
        "session.ended",
        "error",
      ]
    `);
    expect(JSON.stringify(SESSION_EVENT_TYPES)).not.toMatch(/restate|temporal|dbos/iu);
  });
});
