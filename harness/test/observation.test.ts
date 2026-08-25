import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import { model } from "./fixtures.js";

describe("observation", () => {
  it("is causal within a run and fail-open for sync and async observer failures", async () => {
    const types: string[] = [];
    let count = 0;
    const result = Agent(model(async () => "done")).build();
    const session = result.run();
    session.observe((event) => {
      types.push(event.type);
      count += 1;
      if (count % 2) throw new Error("sync observer failure");
      return Promise.reject(new Error("async observer failure"));
    });
    const completion = await session.input("go").completed;
    expect(completion.status).toBe("completed");
    expect(types.indexOf("model.started")).toBeLessThan(types.indexOf("model.completed"));
  });

  it("records requestedModelId only when middleware selected an id", async () => {
    const selected: unknown[] = [];
    const routed = Agent(model(async () => "done"))
      .use("route", async (request, next) => {
        request.model.select({ id: "opus" });
        return next();
      })
      .build();
    const routedSession = routed.run();
    routedSession.observe((event) => {
      if (event.type === "model.started" || event.type === "model.completed")
        selected.push(event.attributes);
    });
    await routedSession.input("go").completed;
    expect(selected).toEqual([{ requestedModelId: "opus" }, { requestedModelId: "opus" }]);
    await routedSession.stop();

    const omitted: unknown[] = [];
    const plain = Agent(model(async () => "done")).build();
    const plainSession = plain.run();
    plainSession.observe((event) => {
      if (event.type === "model.started" || event.type === "model.completed")
        omitted.push(event.attributes);
    });
    await plainSession.input("go").completed;
    expect(omitted).toEqual([undefined, undefined]);
    await plainSession.stop();
  });
});
