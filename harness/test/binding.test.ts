import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import { createAdapterRegistry } from "../src/build/adapters.js";
import { adapter, expectBuildError, model, turn } from "./fixtures.js";

describe("build", () => {
  it("registers middleware in order and returns a frozen agent", () => {
    const builder = Agent(model(async () => "done"))
      .with(adapter())
      .use("first", async (_request, next) => next())
      .use("second", async (_request, next) => next());
    const agent = builder.build();
    expect(builder.build()).toBe(agent);
    expect(() => builder.with(adapter())).toThrow(/after build/);
    expect(agent.manifest.middleware.map((item) => item.id)).toEqual(["first", "second"]);
    expect(agent.manifest.middleware[0]).toEqual({ id: "first" });
    expect(agent.manifest.model).toEqual({ id: "test-model" });
    expect(agent.manifest.adapters).toEqual([{ id: "local" }]);
    expect(agent.manifest.digests.model).toEqual(expect.any(String));
    expect(Object.isFrozen(agent.manifest)).toBe(true);
  });

  it("throws AgentBuildError when middleware ids collide", () => {
    const error = expectBuildError(() =>
      Agent(model(async () => "done"))
        .use("same", async (_request, next) => next())
        .use("same", async (_request, next) => next())
        .build(),
    );
    expect(error.diagnostics.some((item) => item.code === "middleware.duplicate-id")).toBe(true);
  });

  it("throws AgentBuildError when adapter ids collide", () => {
    const error = expectBuildError(() =>
      Agent(model(async () => "done"))
        .with(adapter())
        .with(adapter())
        .build(),
    );
    expect(error.diagnostics.some((item) => item.code === "adapter.duplicate-id")).toBe(true);
  });

  it("throws AgentBuildError when the model invoker is missing invoke", () => {
    const error = expectBuildError(() => Agent({} as never).build());
    expect(error.diagnostics.some((item) => item.code === "harness.invalid-model")).toBe(true);
  });

  it("snapshots middleware descriptors when build() starts", () => {
    const id = { value: "original" };
    const builder = Agent(model(async () => "done")).use(id.value, async (_request, next) =>
      next(),
    );
    id.value = "mutated";
    const agent = builder.build();
    expect(agent.manifest.middleware).toEqual([{ id: "original" }]);
  });

  it("snapshots registered adapters and rejects post-build mutation", () => {
    const local = adapter();
    const builder = Agent(model(async () => "done")).with(local);
    const agent = builder.build();
    expect(() => builder.with(local)).toThrow(/after build/);
    expect(agent.manifest.adapters).toEqual([{ id: "local" }]);
    (local as { id: string }).id = "mutated";
    expect(agent.manifest.adapters).toEqual([{ id: "local" }]);
  });

  it("exposes fixed registry views and hides raw maps on the Agent", () => {
    const local = adapter();
    const invoker = model(async () => "done");
    const agent = Agent(invoker).with(local).build();

    const adapterEntries = createAdapterRegistry([local]).entries as unknown as Record<
      string,
      unknown
    >;
    expect(adapterEntries.set).toBeUndefined();
    expect(adapterEntries.clear).toBeUndefined();
    expect([...createAdapterRegistry([local]).entries.keys()]).toEqual(["local"]);
    expect(agent.manifest.model).toEqual({ id: "test-model" });
    expect(agent.manifest.adapters).toEqual([{ id: "local" }]);

    const rawAgent = agent as unknown as Record<string, unknown>;
    expect(rawAgent.models).toBeUndefined();
    expect(rawAgent.model).toBeUndefined();
    expect(rawAgent.adapters).toBeUndefined();
    expect(rawAgent.catalog).toBeUndefined();
    expect(rawAgent.instructions).toBeUndefined();
  });

  it("starts a Session from run without submitting input", async () => {
    const agent = Agent(model(async () => "hello")).build();
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
