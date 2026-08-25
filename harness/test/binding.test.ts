import { describe, expect, it } from "vitest";
import { Agent, defineCapability } from "../src/index.js";
import { createAdapterRegistry } from "../src/build/adapters.js";
import { createModelRegistry } from "../src/build/models.js";
import { adapter, expectBuildError, model, tool, turn } from "./fixtures.js";

describe("build", () => {
  it("invokes setup in registration order and returns a frozen agent", () => {
    const order: string[] = [];
    const first = defineCapability({
      id: "first",
      setup() {
        order.push("first");
        return { tools: [tool("first")], instructions: ["first"] };
      },
    });
    const second = defineCapability({
      id: "second",
      setup() {
        order.push("second");
        return { tools: [tool("second")], instructions: ["second"] };
      },
    });
    const builder = Agent.create({
      model: model(async () => "done"),
      adapters: { local: adapter() },
    })
      .with(first)
      .with(second);
    const agent = builder.build();
    expect(builder.build()).toBe(agent);
    expect(() => builder.with(first)).toThrow(/after build/);
    expect(order).toEqual(["first", "second"]);
    expect(agent.catalog.map((item) => item.name)).toEqual(["first", "second"]);
    expect(agent.manifest.instructions).toEqual(["first", "second"]);
    expect(Object.isFrozen(agent.manifest)).toBe(true);
  });

  it("throws AgentBuildError when contributions are invalid", () => {
    const error = expectBuildError(() =>
      Agent.create({
        model: model(async () => "done"),
        adapters: { local: adapter() },
      })
        .with(defineCapability({ id: "one", setup: () => ({}) }))
        .with(defineCapability({ id: "two", setup: () => ({ tools: [tool("same")] }) }))
        .with(defineCapability({ id: "three", setup: () => ({ tools: [tool("same")] }) }))
        .build(),
    );
    expect(error.diagnostics.some((item) => item.code === "tool.duplicate-name")).toBe(true);
  });

  it("records a setup exception as a diagnostic", () => {
    const error = expectBuildError(() =>
      Agent.create({ model: model(async () => "done") })
        .with(
          defineCapability({
            id: "broken",
            setup() {
              throw new Error("boom");
            },
          }),
        )
        .build(),
    );
    expect(error.diagnostics).toEqual([
      expect.objectContaining({
        code: "capability.setup-failed",
        message: "Capability 'broken' failed to setup: boom",
        capabilityId: "broken",
      }),
    ]);
  });

  it("rejects a thenable setup contribution", () => {
    const error = expectBuildError(() =>
      Agent.create({ model: model(async () => "done") })
        .with({
          id: "async",
          setup: () => Promise.resolve({}) as never,
        })
        .build(),
    );
    expect(error.diagnostics).toEqual([
      expect.objectContaining({
        code: "capability.invalid-contribution",
        message: "Capability 'async' setup must return a contribution synchronously",
        capabilityId: "async",
      }),
    ]);
  });

  it("exposes fixed registry views and a require-only capability setup context", () => {
    let bindAdapters: unknown;
    const local = adapter();
    const invoker = model(async () => "done");
    const agent = Agent.create({ model: invoker, adapters: { local } })
      .with(
        defineCapability({
          id: "inspect",
          setup({ adapters }) {
            bindAdapters = adapters;
            return {};
          },
        }),
      )
      .build();

    expect(Object.isFrozen(bindAdapters)).toBe(true);
    expect(Object.keys(bindAdapters as object)).toEqual(["require"]);
    expect((bindAdapters as { require(id: string): unknown }).require("local")).toBe(local);
    expect((bindAdapters as Record<string, unknown>).entries).toBeUndefined();

    const adapterEntries = createAdapterRegistry({ local }).entries as unknown as Record<
      string,
      unknown
    >;
    const modelEntries = createModelRegistry({ model: invoker }).entries as unknown as Record<
      string,
      unknown
    >;
    expect(adapterEntries.set).toBeUndefined();
    expect(adapterEntries.clear).toBeUndefined();
    expect(modelEntries.set).toBeUndefined();
    expect(modelEntries.clear).toBeUndefined();
    expect([...createAdapterRegistry({ local }).entries.keys()]).toEqual(["local"]);
    expect([...createModelRegistry({ model: invoker }).entries.keys()]).toEqual(["default"]);

    const rawAgent = agent as unknown as Record<string, unknown>;
    expect(rawAgent.models).toBeUndefined();
    expect(rawAgent.adapters).toBeUndefined();
    expect(rawAgent.catalogByName).toBeUndefined();
  });

  it("snapshots capability descriptors when build() starts", () => {
    const capability = {
      id: "original",
      version: "1",
      setup() {
        capability.id = "mutated";
        capability.version = "2";
        return {};
      },
    };
    const agent = Agent.create({ model: model(async () => "done") })
      .with(capability)
      .build();
    expect(agent.manifest.capabilities).toEqual([{ id: "original", version: "1" }]);
  });

  it("starts a Session from run without submitting input", async () => {
    const agent = Agent.create({ model: model(async () => "hello") }).build();
    const session = agent.run();
    expect(session.state.status).toBe("idle");
    await session.input("hi").completed;
    expect(session.state.transcript.some((entry) => entry.kind === "final")).toBe(true);
    const other = turn(agent, "other");
    expect(other.session.id).not.toBe(session.id);
    await other.handle.completed;
    await session.stop();
    await other.session.stop();
  });
});
