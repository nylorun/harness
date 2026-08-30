import { describe, expect, it, vi } from "vitest";
import { initialState } from "../src/session/state.js";
import { TurnRunner } from "../src/turn/runner.js";
import type { SessionRecord } from "../src/types/session.js";
import { model } from "./fixtures.js";

describe("TurnRunner", () => {
  it("reports every proposed final-turn recording transition", async () => {
    const runner = new TurnRunner(
      {
        middleware: [],
        invoke: model(async () => "done"),
      },
      "session",
      {},
    );
    const transitions: SessionRecord["transition"][] = [];
    const outcome = await runner.start(
      initialState("session"),
      { kind: "user-message", text: "go" },
      {
        signal: new AbortController().signal,
        observe: vi.fn(),
        assertCurrent() {},
        onPlanActive() {},
        async commit(state, transition) {
          transitions.push(transition);
          return state;
        },
        onConversation() {},
        async claimInterrupts(state) {
          return { state, arrivals: [] };
        },
      },
    );

    expect(outcome).toMatchObject({ kind: "final", output: "done" });
    expect(transitions).toEqual(["input", "model-requested", "candidate", "final"]);
  });
});
