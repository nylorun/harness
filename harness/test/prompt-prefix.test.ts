import { describe, expect, it } from "vitest";
import { type ModelConfigurationSnapshot } from "../src/index.js";
import { testAgent, model, tool, toolCalls, turn } from "./fixtures.js";

describe("model configuration", () => {
  it("assembles named slots fresh for every model step", async () => {
    const snapshots: ModelConfigurationSnapshot[] = [];
    let calls = 0;
    const agent = testAgent()
      .use("baseline", async (request, next) => {
        if (request.stepNumber === 1) {
          request.configuration.instructions.set("policy", ["Discarded declaration"]);
          request.configuration.instructions.set("policy", ["Step-one policy"], { order: 20 });
          request.configuration.tools.set("tools", [tool("discarded")]);
          request.configuration.tools.set("tools", [tool()], { order: 20 });
        }
        return next();
      })
      .with(
        model(async (_call, { request }) => {
          snapshots.push(request.configuration);
          return ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
        }),
      )
      .build();

    await turn(agent).handle.completed;

    expect(snapshots.map((snapshot) => snapshot.instructions.map((item) => item.text))).toEqual([
      ["Step-one policy"],
      [],
    ]);
    expect(snapshots.map((snapshot) => snapshot.tools.map((tool) => tool.name))).toEqual([
      ["echo"],
      [],
    ]);
  });

  it("orders same-step slots canonically and attributes them", async () => {
    let configuration!: ModelConfigurationSnapshot;
    const agent = testAgent()
      .use("later", async (request, next) => {
        request.configuration.instructions.set("a", ["second"], { order: 20 });
        request.configuration.tools.set("late", [tool("late")], { order: 20 });
        return next();
      })
      .use("first", async (request, next) => {
        request.configuration.instructions.set("z", ["first"], { order: 10 });
        request.configuration.tools.set("first", [tool("first")], { order: 10 });
        return next();
      })
      .with(
        model(async (_call, { request }) => {
          configuration = request.configuration;
          return "done";
        }),
      )
      .build();
    await turn(agent).handle.completed;

    expect(configuration.instructions.map((item) => item.text)).toEqual(["first", "second"]);
    expect(configuration.tools.map((item) => item.name)).toEqual(["first", "late"]);
    expect(configuration.contributors.map((item) => `${item.middlewareId}:${item.slot}`)).toEqual([
      "first:z",
      "later:a",
      "first:first",
      "later:late",
    ]);
  });

  it("uses the current executable implementation when an equivalent contract is re-declared", async () => {
    const routes: string[] = [];
    const observedOwners: unknown[] = [];
    let calls = 0;
    const agent = testAgent()
      .use("tools", async (request, next) => {
        request.configuration.tools.set("echo", [
          tool("echo", async () => {
            routes.push(request.stepNumber === 1 ? "first" : "later");
            return { kind: "completed", output: "ok" };
          }),
        ]);
        return next();
      })
      .with(
        model(async () => {
          calls += 1;
          return calls <= 2 ? toolCalls({ id: `call-${calls}`, name: "echo", args: {} }) : "done";
        }),
      )
      .build();
    const session = agent.run();
    session.observe((event) => {
      if (event.type === "model.requested")
        observedOwners.push(event.attributes.configuration.tools[0]?.owner);
    });
    await session.input("go").completed;

    expect(observedOwners).toEqual([
      { middlewareId: "tools", slot: "echo" },
      { middlewareId: "tools", slot: "echo" },
      { middlewareId: "tools", slot: "echo" },
    ]);
    expect(routes).toEqual(["first", "later"]);
  });
});
