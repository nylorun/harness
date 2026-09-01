import { describe, expect, it } from "vitest";
import { Agent } from "../src/index.js";
import { expectBuildError, model, testAgent, turn } from "./fixtures.js";

describe("build", () => {
  it("seals middleware order and returns a frozen adapter-free manifest", () => {
    const builder = testAgent()
      .use("first", async (_request, next) => next())
      .use("second", async (_request, next) => next())
      .with(model(async () => "done"));
    const agent = builder.build();
    expect(builder.build()).toBe(agent);
    expect(agent.id).toBe("test");
    expect(agent.name).toBe("Test");
    expect(agent.manifest).toEqual({
      id: "test",
      name: "Test",
      middleware: [{ id: "first" }, { id: "second" }],
    });
    expect(agent.manifest).not.toHaveProperty("adapters");
    expect(Object.isFrozen(agent.manifest)).toBe(true);
  });

  it("rejects middleware mutation after with()", () => {
    const builder = testAgent();
    builder.with(model(async () => "done"));
    expect(() => builder.use("late", async (_request, next) => next())).toThrow(/after with/);
    expect(() => builder.with(model(async () => "other"))).toThrow(/after with/);
  });

  it("rejects duplicate middleware ids", () => {
    const builder = testAgent()
      .use("same", async (_request, next) => next())
      .use("same", async (_request, next) => next())
      .with(model(async () => "done"));
    expect(() => builder.build()).toThrow(/Duplicate middleware id/);
  });

  it("records a model declaration as middleware rather than manifest model state", () => {
    const agent = testAgent()
      .use({ id: "model", model: { id: "opus", controls: { temperature: 0.2 } } })
      .with(model(async () => "done"))
      .build();
    expect(agent.manifest).toEqual({
      id: "test",
      name: "Test",
      middleware: [{ id: "model" }],
    });
    expect(agent.manifest).not.toHaveProperty("model");
  });

  it("reports a missing model callback", () => {
    const error = expectBuildError(() =>
      testAgent()
        .with({} as never)
        .build(),
    );
    expect(error.diagnostics.some((item) => item.code === "harness.invalid-model")).toBe(true);
  });

  it("reports empty identity at build", () => {
    const error = expectBuildError(() =>
      Agent({ id: "", name: "" })
        .with(model(async () => "done"))
        .build(),
    );
    expect(error.diagnostics.map((item) => item.code)).toEqual([
      "agent.invalid-id",
      "agent.invalid-name",
    ]);
  });

  it("assigns generated middleware ids and skips explicit collisions", () => {
    const agent = testAgent()
      .use("middleware-1", async (_request, next) => next())
      .use(async (_request, next) => next())
      .use("named", async (_request, next) => next())
      .with(model(async () => "done"))
      .build();
    expect(agent.manifest.middleware.map((item) => item.id)).toEqual([
      "middleware-1",
      "middleware-2",
      "named",
    ]);
  });

  it("snapshots middleware descriptors when build starts", () => {
    const id = { value: "original" };
    const builder = testAgent()
      .use(id.value, async (_request, next) => next())
      .with(model(async () => "done"));
    id.value = "mutated";
    expect(builder.build().manifest.middleware).toEqual([{ id: "original" }]);
  });

  it("hides internal model and tool registries", () => {
    const agent = testAgent()
      .with(model(async () => "done"))
      .build() as unknown as Record<string, unknown>;
    expect(agent.models).toBeUndefined();
    expect(agent.model).toBeUndefined();
    expect(agent.adapters).toBeUndefined();
    expect(agent.catalog).toBeUndefined();
    expect(agent.instructions).toBeUndefined();
  });

  it("starts an idle Session without submitting input", async () => {
    const agent = testAgent()
      .with(model(async () => "hello"))
      .build();
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

  it("applies constructor instructions on the reserved agent slot", async () => {
    const seen: string[] = [];
    const contributors: Array<{ readonly middlewareId: string; readonly slot: string }> = [];
    const agent = testAgent({ instructions: "Be concise." })
      .with(
        model(async (_call, { request }) => {
          seen.push(...request.instructions);
          return "done";
        }),
      )
      .build();
    const session = agent.run();
    session.observe((event) => {
      if (event.type === "model.requested")
        contributors.push(...event.attributes.configuration.contributors);
    });
    await session.input("go").completed;
    expect(seen).toEqual(["Be concise."]);
    expect(contributors).toContainEqual(
      expect.objectContaining({ middlewareId: "agent", slot: "agent" }),
    );
    expect(agent.manifest.middleware.map((item) => item.id)).toEqual(["agent"]);
    await session.stop();
  });

  it("rejects a capability that reuses the reserved agent id", () => {
    const error = expectBuildError(() =>
      testAgent({ instructions: "Stay reserved." })
        .use({ id: "agent", instructions: ["overlap"] })
        .with(model(async () => "done"))
        .build(),
    );
    expect(error.diagnostics.some((item) => item.code === "middleware.duplicate-id")).toBe(true);
  });
});
