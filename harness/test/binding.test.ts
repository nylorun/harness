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
    expect(agent.manifest.model).toBeUndefined();
    expect(agent.manifest.adapters).toEqual([{ id: "local" }]);
    expect(Object.isFrozen(agent.manifest)).toBe(true);
  });

  it("seals an optional model directive onto the manifest", () => {
    const agent = Agent(
      model(async () => "done"),
      {
        id: "opus",
        controls: { temperature: 0.2 },
        config: { reasoning: "high" },
      },
    ).build();
    expect(agent.manifest.model).toEqual({
      id: "opus",
      controls: { temperature: 0.2 },
      config: { reasoning: "high" },
    });
    expect(Object.isFrozen(agent.manifest.model)).toBe(true);
  });

  it("throws AgentBuildError when the sealed directive is invalid", () => {
    const error = expectBuildError(() =>
      Agent(
        model(async () => "done"),
        { id: "", extra: true } as never,
      ).build(),
    );
    expect(error.diagnostics.some((item) => item.code === "harness.invalid-directive")).toBe(true);
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

  it("throws AgentBuildError when the model invoke callback is missing", () => {
    const error = expectBuildError(() => Agent({} as never).build());
    expect(error.diagnostics.some((item) => item.code === "harness.invalid-model")).toBe(true);
  });

  it("assigns generated middleware ids when omitted", () => {
    const agent = Agent(model(async () => "done"))
      .use(async (_request, next) => next())
      .use("named", async (_request, next) => next())
      .build();
    expect(agent.manifest.middleware.map((item) => item.id)).toEqual(["middleware-1", "named"]);
  });

  it("skips generated ids that collide with an explicit middleware id", () => {
    const agent = Agent(model(async () => "done"))
      .use("middleware-1", async (_request, next) => next())
      .use(async (_request, next) => next())
      .build();
    expect(agent.manifest.middleware.map((item) => item.id)).toEqual([
      "middleware-1",
      "middleware-2",
    ]);
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
    const invoke = model(async () => "done");
    const agent = Agent(invoke).with(local).build();

    const adapterEntries = createAdapterRegistry([local]).entries as unknown as Record<
      string,
      unknown
    >;
    expect(adapterEntries.set).toBeUndefined();
    expect(adapterEntries.clear).toBeUndefined();
    expect([...createAdapterRegistry([local]).entries.keys()]).toEqual(["local"]);
    expect(agent.manifest.model).toBeUndefined();
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
