import { describe, expect, it } from "vitest";
import { Agent, type ModelConfigurationSnapshot } from "../src/index.js";
import { adapter, model, tool, toolCalls, turn } from "./fixtures.js";

describe("model configuration", () => {
  it("assembles named slots fresh for every model step", async () => {
    const snapshots: ModelConfigurationSnapshot[] = [];
    let calls = 0;
    const agent = Agent(
      model(async (_call, { request }) => {
        snapshots.push(request.configuration);
        return ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
      }),
    )
      .with(adapter())
      .use("baseline", async (request, next) => {
        if (request.stepNumber === 1) {
          request.configuration.instructions.set("policy", ["Discarded declaration"]);
          request.configuration.instructions.set("policy", ["Step-one policy"], { order: 20 });
          request.configuration.tools.set("tools", [tool("discarded")]);
          request.configuration.tools.set("tools", [tool()], { order: 20 });
        }
        return next();
      })
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
    const agent = Agent(
      model(async (_call, { request }) => {
        configuration = request.configuration;
        return "done";
      }),
    )
      .with(adapter())
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

  it("uses the current tool route when an equivalent contract is re-declared", async () => {
    const routes: string[] = [];
    const observedRoutes: string[] = [];
    let calls = 0;
    const agent = Agent(
      model(async () => {
        calls += 1;
        return calls <= 2 ? toolCalls({ id: `call-${calls}`, name: "echo", args: {} }) : "done";
      }),
    )
      .with(
        adapter(async (call) => {
          routes.push(call.executeWith);
          return { kind: "completed", output: "ok" };
        }),
      )
      .with({
        id: "alternate",
        execute: async (call) => {
          routes.push(call.executeWith);
          return { kind: "completed", output: "ok" };
        },
      })
      .use("tools", async (request, next) => {
        request.configuration.tools.set("echo", [
          tool("echo", request.stepNumber === 1 ? "local" : "alternate"),
        ]);
        return next();
      })
      .build();
    const session = agent.run();
    session.observe((event) => {
      if (event.type === "model.requested")
        observedRoutes.push(event.attributes.configuration.tools[0]?.executeWith ?? "");
    });
    await session.input("go").completed;

    expect(observedRoutes).toEqual(["local", "alternate", "alternate"]);
    expect(routes).toEqual(["local", "alternate"]);
  });
});
