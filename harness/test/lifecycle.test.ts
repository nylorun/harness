import { describe, expect, it } from "vitest";
import { Harness, defineCapability, defineMiddleware } from "../src/index.js";
import { model, turn } from "./fixtures.js";

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
    const result = await new Harness({
      model: model(async () => {
        markStarted();
        await modelGate;
        return "late";
      }),
    }).build();
    if (!result.ok) throw new Error("build failed");

    const { session, handle } = turn(result.agent, "go");
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
    const result = await new Harness({ model: model(async () => "done") })
      .add(
        defineCapability({
          id: "turn-policy",
          middleware: [
            defineMiddleware({
              id: "max-one-turn",
              beforeModel(ctx) {
                if (ctx.input.turnNumber > 1)
                  ctx.tripwire({
                    code: "policy.max-turns",
                    message: "Application turn limit reached",
                    scope: "session",
                  });
              },
            }),
          ],
        }),
      )
      .build();
    if (!result.ok) throw new Error("build failed");
    const { session, handle } = turn(result.agent, "one");
    await handle.completed;
    await expect(
      session.input({ kind: "user-message", text: "two" }).completed,
    ).resolves.toMatchObject({
      status: "completed",
    });
    expect(session.state.status).toBe("stopped");
    await session.stop();
  });

  it("keeps a Session usable after a step-scoped middleware tripwire", async () => {
    const result = await new Harness({ model: model(async () => "done") })
      .add(
        defineCapability({
          id: "step-policy",
          middleware: [
            defineMiddleware({
              id: "step-tripwire",
              beforeModel(ctx) {
                ctx.tripwire({
                  code: "policy.step",
                  message: `Step ${ctx.input.stepNumber} rejected`,
                  scope: "step",
                });
              },
            }),
          ],
        }),
      )
      .build();
    if (!result.ok) throw new Error("build failed");
    const { session, handle: first } = turn(result.agent, "one");
    await expect(first.completed).resolves.toMatchObject({
      status: "completed",
      events: [
        expect.objectContaining({
          type: "tripwire",
          tripwire: expect.objectContaining({ code: "policy.step" }),
        }),
      ],
    });
    await expect(
      session.input({ kind: "user-message", text: "two" }).completed,
    ).resolves.toMatchObject({
      status: "completed",
    });
    expect(session.state.status).toBe("idle");
    await session.stop();
  });
});
