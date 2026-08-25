import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import { model } from "./fixtures.js";

describe("observation", () => {
  it("is causal within a run and fail-open for sync and async observer failures", async () => {
    const types: string[] = [];
    let count = 0;
    const result = Agent.create({
      model: model(async () => "done"),
    }).build();
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
});
