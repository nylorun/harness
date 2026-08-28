import { describe, expect, it, vi } from "vitest";
import { Agent, tool as authoredTool } from "../src/index.js";
import { adapter, offer, model, tool, toolCalls, turn } from "./fixtures.js";
import { z } from "zod";

describe("step pipeline", () => {
  it("short-circuits with zero Model calls", async () => {
    const invoke = vi.fn(async () => "done");
    const result = Agent(model(invoke))
      .use("turn-budget", async (request, next) => {
        if (request.turnNumber > 0) {
          return request.tripwire({ code: "turn.limit", message: "Limit reached" });
        }
        return next();
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "turn.limit" } },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not retain a named tool slot on the next Step", async () => {
    let step = 0;
    const seen: string[][] = [];
    const result = Agent(
      model(async (_call, { request }) => {
        seen.push(request.tools.map((item) => item.name));
        return ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done";
      }),
    )
      .with(adapter())
      .use("once", async (request, next) => {
        if (request.stepNumber === 1) request.configuration.tools.set("once", [tool()]);
        return next();
      })
      .build();
    await turn(result, "go").handle.completed;
    expect(seen).toEqual([["echo"], []]);
  });

  it("tripwires duplicate dynamic tools before the Model runs", async () => {
    const invoke = vi.fn(async () => "done");
    const result = Agent(model(invoke))
      .with(adapter())
      .use("dup", async (request, next) => {
        request.configuration.tools.set("dup", [tool("echo"), tool("echo")]);
        return next();
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "tripwire", tripwire: { code: "configuration.duplicate-tool-name" } },
    ]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("keeps canonical IDs and monotonic denials across replace", async () => {
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "nope" }));
    let step = 0;
    const result = Agent(
      model(async () => {
        if (++step > 1) return "done";
        return toolCalls(
          { id: "keep", name: "echo", args: { n: 1 } },
          { id: "drop", name: "echo", args: { n: 2 } },
        );
      }),
    )
      .with(adapter(execute))
      .use("outer", async (_request, next) => {
        const response = await next();
        response.replace(toolCalls({ id: "keep", name: "echo", args: { n: 1 } }));
        return response;
      })
      .use("inner", async (request, next) => {
        request.configuration.tools.set("inner", [tool()]);
        const response = await next();
        expect(response.toolCalls().map((call) => call.id)).toEqual(["keep", "drop"]);
        response.deny("keep", "blocked");
        return response;
      })
      .build();
    const { session, handle } = turn(result, "go");
    await handle.completed;
    const results = session.state.transcript.find((entry) => entry.kind === "tool-results");
    expect(results?.kind).toBe("tool-results");
    if (results?.kind === "tool-results") {
      expect(results.results).toEqual([
        expect.objectContaining({ callId: "keep", kind: "denied", reason: "blocked" }),
      ]);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("tripwires replace that changes a retained call identity", async () => {
    let step = 0;
    const result = Agent(
      model(async () =>
        ++step === 1 ? toolCalls({ id: "keep", name: "echo", args: { n: 1 } }) : "done",
      ),
    )
      .with(adapter())
      .use("rewrite", async (request, next) => {
        request.configuration.tools.set("rewrite", [tool()]);
        const response = await next();
        response.replace(toolCalls({ id: "keep", name: "echo", args: { n: 99 } }));
        return response;
      })
      .build();
    const output = (await turn(result, "go").handle.completed).events;
    expect(output).toMatchObject([
      { type: "input", event: { kind: "user-message", text: "go" } },
      { type: "candidate" },
      { type: "tripwire", tripwire: { code: "response.invalid-replacement" } },
    ]);
  });

  it("throws on late lease mutation without stopping a settled Session", async () => {
    const observed: string[] = [];
    let lateError = "";
    const result = Agent(model(async () => "done"))
      .use("late", async (request, next) => {
        setTimeout(() => {
          try {
            request.configuration.tools.set("late", [tool()]);
          } catch (error) {
            lateError = error instanceof Error ? error.message : String(error);
          }
        }, 0);
        return next();
      })
      .build();
    const session = result.run();
    session.observe((event) => observed.push(event.type));
    const handle = session.input("go");
    await handle.completed;
    expect(session.state.status).toBe("idle");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(lateError).toMatch(/no longer active/);
    expect(observed).toContain("middleware.lease-violation");
    expect(session.state.status).toBe("idle");
  });

  it("freezes the tool snapshot so later mutations do not change the bound parameters", async () => {
    const definition = authoredTool({
      name: "echo",
      parameters: z.object({ text: z.string() }),
      executeWith: "local",
    });
    const schemas: unknown[] = [];
    const result = Agent(
      model(async (_call, { request }) => {
        schemas.push(request.tools[0]?.parameters.jsonSchema);
        return "done";
      }),
    )
      .with(adapter())
      .use("snapshot", async (request, next) => {
        request.configuration.tools.set("snapshot", [definition]);
        (definition as { parameters: unknown }).parameters = z.object({ admin: z.string() });
        return next();
      })
      .build();
    await turn(result, "go").handle.completed;
    expect(schemas).toMatchObject([{ type: "object", properties: { text: { type: "string" } } }]);
  });

  it("emits step.started before middleware and model.requested, and tool.sealed after the onion", async () => {
    const types: string[] = [];
    let step = 0;
    const result = Agent(
      model(async () =>
        ++step === 1 ? toolCalls({ id: "call", name: "echo", args: {} }) : "done",
      ),
    )
      .with(adapter())
      .use("test", offer(tool()))
      .build();
    const session = result.run();
    session.observe((event) => types.push(event.type));
    const handle = session.input("go");
    await handle.completed;
    expect(types.indexOf("step.started")).toBeLessThan(types.indexOf("middleware.entered"));
    expect(types.indexOf("middleware.entered")).toBeLessThan(types.indexOf("model.requested"));
    expect(types.indexOf("model.requested")).toBeLessThan(types.indexOf("tool.sealed"));
    expect(types.filter((type) => type === "step.started").length).toBeGreaterThan(0);
  });

  it("keeps a sibling Session running after a session-scoped tripwire", async () => {
    const agent = Agent(model(async () => "ok"))
      .use("boom", async (request, next) => {
        if (request.session.userId === "a") {
          return request.tripwire({
            code: "policy.stop",
            message: "stop A",
            scope: "session",
          });
        }
        return next();
      })
      .build();
    const a = turn(agent, "go", { userId: "a" });
    const b = turn(agent, "go", { userId: "b" });
    await expect(a.handle.completed).resolves.toMatchObject({
      events: [
        { type: "input", event: { kind: "user-message", text: "go" } },
        { type: "tripwire", tripwire: { code: "policy.stop" } },
      ],
    });
    expect(a.session.state.status).toBe("stopped");
    await expect(b.handle.completed).resolves.toMatchObject({
      events: [
        { type: "input", event: { kind: "user-message", text: "go" } },
        { type: "candidate" },
        { type: "final", output: "ok" },
      ],
    });
    expect(b.session.state.status).toBe("idle");
  });

  it("lets host-level assembly decide whether a folder tool is contributed", async () => {
    const folder = (enabled: boolean) => async (request, next) => {
      if (enabled) request.configuration.tools.set("folder", [tool("folder")]);
      request.configuration.instructions.set("folder", ["from folder"]);
      return next();
    };
    const seen: string[][] = [];
    const builder = Agent(
      model(async (_call, { request }) => {
        seen.push(request.tools.map((item) => item.name));
        return "done";
      }),
    )
      .with(adapter())
      .use("nylorun-folder", folder(false));
    await turn(builder.build(), "go").handle.completed;
    expect(seen).toEqual([[]]);
    expect(builder.build().manifest.middleware.map((item) => item.id)).toEqual(["nylorun-folder"]);
  });
});
