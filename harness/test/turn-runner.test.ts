import { describe, expect, it, vi } from "vitest";
import { createAdapterRegistry } from "../src/build/adapters.js";
import { initialState } from "../src/session/state.js";
import { TurnRunner } from "../src/turn/runner.js";
import { model } from "./fixtures.js";

describe("TurnRunner", () => {
  it("returns a final outcome while reporting each committed state transition", async () => {
    const agent = {
      middleware: [],
      invoke: model(async () => "done"),
      adapters: createAdapterRegistry(),
    };
    const states: string[] = [];
    const runner = new TurnRunner(agent, "session", {});
    const outcome = await runner.start(
      initialState("session"),
      { kind: "user-message", text: "go" },
      {
        signal: new AbortController().signal,
        observe: vi.fn(),
        assertCurrent() {},
        onPlanActive() {},
        onState: (state) => states.push(state.status),
        onConversation() {},
        claimInterrupts: () => [],
      },
    );

    expect(outcome).toMatchObject({ kind: "final", output: "done" });
    expect(states).toEqual(["running", "running"]);
  });
});
