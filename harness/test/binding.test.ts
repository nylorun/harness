import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import { expectBuildError, model, turn } from "./fixtures.js";

describe("build", () => {
  it("seals middleware order and returns a frozen adapter-free manifest", () => {
    const builder = Agent(model(async () => "done"))
      .use("first", async (_request, next) => next())
      .use("second", async (_request, next) => next());
    const agent = builder.build();
    expect(builder.build()).toBe(agent);
    expect(agent.manifest).toEqual({ middleware: [{ id: "first" }, { id: "second" }] });
    expect(agent.manifest).not.toHaveProperty("adapters");
    expect(Object.isFrozen(agent.manifest)).toBe(true);
  });

  it("rejects middleware mutation after build", () => {
    const builder = Agent(model(async () => "done"));
    builder.build();
    expect(() => builder.use("late", async (_request, next) => next())).toThrow(/after build/);
  });

  it("rejects duplicate middleware ids", () => {
    const builder = Agent(model(async () => "done"))
      .use("same", async (_request, next) => next())
      .use("same", async (_request, next) => next());
    expect(() => builder.build()).toThrow(/Duplicate middleware id/);
  });

  it("records a model declaration as middleware rather than manifest model state", () => {
    const agent = Agent(model(async () => "done"))
      .use({ id: "model", model: { id: "opus", controls: { temperature: 0.2 } } })
      .build();
    expect(agent.manifest).toEqual({ middleware: [{ id: "model" }] });
    expect(agent.manifest).not.toHaveProperty("model");
  });

  it("reports a missing model callback", () => {
    const error = expectBuildError(() => Agent({} as never).build());
    expect(error.diagnostics.some((item) => item.code === "harness.invalid-model")).toBe(true);
  });

  it("assigns generated middleware ids and skips explicit collisions", () => {
    const agent = Agent(model(async () => "done"))
      .use("middleware-1", async (_request, next) => next())
      .use(async (_request, next) => next())
      .use("named", async (_request, next) => next())
      .build();
    expect(agent.manifest.middleware.map((item) => item.id)).toEqual([
      "middleware-1",
      "middleware-2",
      "named",
    ]);
  });

  it("snapshots middleware descriptors when build starts", () => {
    const id = { value: "original" };
    const builder = Agent(model(async () => "done")).use(id.value, async (_request, next) =>
      next(),
    );
    id.value = "mutated";
    expect(builder.build().manifest.middleware).toEqual([{ id: "original" }]);
  });

  it("hides internal model and tool registries", () => {
    const agent = Agent(model(async () => "done")).build() as unknown as Record<string, unknown>;
    expect(agent.models).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.adapters).toBeUndefined();
    expect(agent.catalog).toBeUndefined();
    expect(agent.instructions).toBeUndefined();
  });

  it("starts an idle Session without submitting input", async () => {
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
