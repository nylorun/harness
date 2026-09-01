import { describe, expect, it } from "vitest";
import { testAgent, model, turn } from "./fixtures.js";

describe("lifecycle", () => {
  it("retains Session work until abort-ignoring model calls settle", async () => {
    let settleModel!: () => void;
    let markStarted!: () => void;
    const modelStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const modelGate = new Promise<void>((resolve) => {
      settleModel = resolve;
    });
    const result = testAgent()
      .with(
        model(async () => {
          markStarted();
          await modelGate;
          return "late";
        }),
      )
      .build();

    const { session, handle } = turn(result, "go");
    await modelStarted;
    const stopped = session.stop();
    let ended = false;
    void stopped.then(() => {
      ended = true;
    });
    await Promise.resolve();
    expect(ended).toBe(false);

    settleModel();
    await expect(handle.completed).resolves.toMatchObject({ status: "stopped" });
    await stopped;
    expect(session.state.status).toBe("stopped");
  });

  it("lets middleware stop a Session with an application-owned turn policy", async () => {
    const result = testAgent()
      .use("max-one-turn", async (request, next) => {
        if (request.turnNumber > 1) {
          return request.tripwire({
            code: "policy.max-turns",
            message: "Application turn limit reached",
            scope: "session",
          });
        }
        return next();
      })
      .with(model(async () => "done"))
      .build();
    const { session, handle } = turn(result, "one");
    await handle.completed;
    await expect(session.input("two").completed).resolves.toMatchObject({
      status: "completed",
    });
    expect(session.state.status).toBe("stopped");
    await session.stop();
  });

  it("keeps a Session usable after a step-scoped middleware tripwire", async () => {
    const result = testAgent()
      .use("step-tripwire", async (request, next) => {
        return request.tripwire({
          code: "policy.step",
          message: `Step ${request.stepNumber} rejected`,
          scope: "step",
        });
      })
      .with(model(async () => "done"))
      .build();
    const { session, handle: first } = turn(result, "one");
    await expect(first.completed).resolves.toMatchObject({
      status: "completed",
      events: [
        expect.objectContaining({
          type: "input",
          event: { kind: "user-message", text: "one" },
        }),
        expect.objectContaining({
          type: "tripwire",
          tripwire: expect.objectContaining({ code: "policy.step" }),
        }),
      ],
    });
    await expect(session.input("two").completed).resolves.toMatchObject({
      status: "completed",
    });
    expect(session.state.status).toBe("idle");
    await session.stop();
  });
});
