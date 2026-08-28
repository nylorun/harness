import { describe, expect, it } from "vitest";
import { Agent, type ObserveEvent, type PromptPrefixSnapshot } from "../src/index.js";
import { adapter, model, tool, toolCalls, turn } from "./fixtures.js";

describe("prompt prefix stability", () => {
  it("persists named slots and reuses the canonical snapshot when unchanged", async () => {
    const prefixes: PromptPrefixSnapshot[] = [];
    let calls = 0;
    const agent = Agent(
      model(async (_call, { request }) => {
        prefixes.push(request.prefix);
        return ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
      }),
    )
      .with(adapter())
      .use("baseline", async (request, next) => {
        if (request.stepNumber === 1) {
          request.prefix.instructions.set("policy", ["Stable policy"], { order: 20 });
          request.prefix.tools.set("tools", [tool()], { order: 20 });
        }
        return next();
      })
      .build();
    const observed: ObserveEvent[] = [];
    const session = agent.run();
    session.observe((event) => observed.push(event));
    await session.input("go").completed;

    expect(prefixes).toHaveLength(2);
    expect(prefixes[1]).toBe(prefixes[0]);
    expect(
      observed
        .filter((event) => event.type === "model.prefix")
        .map((event) => (event.type === "model.prefix" ? event.attributes.status : undefined)),
    ).toEqual(["initial", "unchanged"]);
  });

  it("orders slots canonically and attributes declared changes", async () => {
    let prefix!: PromptPrefixSnapshot;
    const agent = Agent(
      model(async (_call, { request }) => {
        prefix = request.prefix;
        return "done";
      }),
    )
      .with(adapter())
      .use("later", async (request, next) => {
        request.prefix.instructions.set("a", ["second"], { order: 20 });
        request.prefix.tools.set("late", [tool("late")], { order: 20 });
        return next();
      })
      .use("first", async (request, next) => {
        request.prefix.instructions.set("z", ["first"], { order: 10 });
        request.prefix.tools.set("first", [tool("first")], { order: 10 });
        return next();
      })
      .build();
    await turn(agent).handle.completed;

    expect(prefix.instructions.map((item) => item.text)).toEqual(["first", "second"]);
    expect(prefix.tools.map((item) => item.name)).toEqual(["first", "late"]);
    expect(prefix.contributors.map((item) => `${item.middlewareId}:${item.slot}`)).toEqual([
      "first:z",
      "later:a",
      "first:first",
      "later:late",
    ]);
  });

  it("requires a reason for non-initial effective changes in strict mode", async () => {
    let calls = 0;
    const agent = Agent(
      model(async () =>
        ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
      ),
    )
      .with(adapter())
      .use("policy", async (request, next) => {
        request.prefix.tools.set("tools", [tool()]);
        if (request.stepNumber === 2) request.prefix.instructions.set("changed", ["New policy"]);
        return next();
      })
      .build();
    const completion = await turn(agent, "go", { prefixPolicy: "strict" }).handle.completed;
    expect(completion.events.at(-1)).toMatchObject({
      type: "tripwire",
      tripwire: { code: "prefix.strict-unreasoned-change" },
    });
  });

  it("removes a middleware-owned tool slot through an explicit mutation", async () => {
    const visible: string[][] = [];
    let calls = 0;
    const agent = Agent(
      model(async (_call, { request }) => {
        visible.push(request.prefix.tools.map((item) => item.name));
        return ++calls === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
      }),
    )
      .with(adapter())
      .use("capabilities", async (request, next) => {
        if (request.stepNumber === 1) request.prefix.tools.set("tools", [tool("echo")]);
        else request.prefix.tools.remove("tools", { reason: "Tool result completed." });
        return next();
      })
      .build();
    await turn(agent).handle.completed;
    expect(visible).toEqual([["echo"], []]);
  });

  it("does not let a middleware remove another middleware's tool slot", async () => {
    const visible: string[][] = [];
    const agent = Agent(
      model(async (_call, { request }) => {
        visible.push(request.prefix.tools.map((item) => item.name));
        return "done";
      }),
    )
      .with(adapter())
      .use("security", async (request, next) => {
        request.prefix.tools.set("danger", [tool("danger")]);
        return next();
      })
      .use("plugin", async (request, next) => {
        request.prefix.tools.remove("danger");
        return next();
      })
      .build();

    await turn(agent).handle.completed;

    expect(visible).toEqual([["danger"]]);
  });
});
