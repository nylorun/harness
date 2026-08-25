import { describe, expect, it } from "vitest";
import { Harness, defineCapability } from "../src/index.js";
import { createAdapterRegistry } from "../src/build/adapters.js";
import { createModelRegistry } from "../src/build/models.js";
import { adapter, model, tool, turn } from "./fixtures.js";

describe("build", () => {
  it("settles setup concurrently and merges in registration order", async () => {
    const order: string[] = [];
    const first = defineCapability({
      id: "first",
      async setup() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push("first-finished");
        return { tools: [tool("first")], instructions: ["first"] };
      },
    });
    const second = defineCapability({
      id: "second",
      async setup() {
        order.push("second-finished");
        return { tools: [tool("second")], instructions: ["second"] };
      },
    });
    const harness = new Harness({
      model: model(async () => "done"),
      adapters: { local: adapter() },
    })
      .add(first)
      .add(second);
    const promise = harness.build();
    expect(harness.build()).toBe(promise);
    expect(() => harness.add(first)).toThrow(/after build/);
    const result = await promise;
    expect(order).toEqual(["second-finished", "first-finished"]);
    expect(result.ok && result.agent.catalog.map((item) => item.name)).toEqual(["first", "second"]);
    expect(result.ok && result.manifest.instructions).toEqual(["first", "second"]);
    expect(result.ok && Object.isFrozen(result.manifest)).toBe(true);
  });

  it("returns diagnostics when contributions are invalid", async () => {
    const harness = new Harness({
      model: model(async () => "done"),
      adapters: { local: adapter() },
    })
      .add(defineCapability({ id: "one", setup: () => ({}) }))
      .add(defineCapability({ id: "two", setup: () => ({ tools: [tool("same")] }) }))
      .add(defineCapability({ id: "three", setup: () => ({ tools: [tool("same")] }) }));
    const result = await harness.build();
    expect(result.ok).toBe(false);
    expect(
      !result.ok && result.diagnostics.some((item) => item.code === "tool.duplicate-name"),
    ).toBe(true);
  });

  it("exposes fixed registry views and a require-only capability setup context", async () => {
    let bindAdapters: unknown;
    const local = adapter();
    const invoker = model(async () => "done");
    const result = await new Harness({ model: invoker, adapters: { local } })
      .add(
        defineCapability({
          id: "inspect",
          setup({ adapters }) {
            bindAdapters = adapters;
            return {};
          },
        }),
      )
      .build();
    if (!result.ok) throw new Error("build failed");

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

    const rawAgent = result.agent as unknown as Record<string, unknown>;
    expect(rawAgent.models).toBeUndefined();
    expect(rawAgent.adapters).toBeUndefined();
    expect(rawAgent.catalogByName).toBeUndefined();
  });

  it("snapshots capability descriptors at add()", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const capability = {
      id: "original",
      version: "1",
      async setup() {
        await gate;
        return {};
      },
    };
    const pending = new Harness({ model: model(async () => "done") }).add(capability).build();
    capability.id = "mutated";
    capability.version = "2";
    release();
    const result = await pending;
    if (!result.ok) throw new Error("build failed");
    expect(result.manifest.capabilities).toEqual([{ id: "original", version: "1" }]);
  });

  it("starts a Session from run without submitting input", async () => {
    const result = await new Harness({ model: model(async () => "hello") }).build();
    if (!result.ok) throw new Error("build failed");
    const session = result.agent.run();
    expect(session.state.status).toBe("idle");
    await session.input("hi").completed;
    expect(session.state.transcript.some((entry) => entry.kind === "final")).toBe(true);
    const other = turn(result.agent, "other");
    expect(other.session.id).not.toBe(session.id);
    await other.handle.completed;
    await session.stop();
    await other.session.stop();
  });
});
