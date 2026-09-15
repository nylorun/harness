import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  Agent,
  defineToolFamily,
  validateExecutionState,
  type ExecutionState,
  type ModelAdapter,
} from "../src/index.js";

const candidate = (name: string, id = "call") => ({
  output: [{ type: "tool-call" as const, id, name, args: {} }],
});
const roundtrip = (state: ExecutionState): ExecutionState => JSON.parse(JSON.stringify(state));

describe("stateless execution", () => {
  it("supports minimal calls, independent runs and serializable immutable continuation", async () => {
    const agent = Agent({ id: "a", name: "A" }).build();
    const one = await agent.run({ input: "one", onModelCall: async () => "hello" });
    expect(one.status).toBe("completed");
    const saved = JSON.stringify(one.state);
    const two = await agent.run({
      state: roundtrip(one.state),
      input: "two",
      onModelCall: async (call) => {
        expect(JSON.stringify(call.prompt)).toContain("one");
        return "world";
      },
    });
    expect(two.state.turnCount).toBe(2);
    expect(JSON.stringify(one.state)).toBe(saved);
    expect(validateExecutionState(two.state)).toEqual(two.state);
    expect(
      (await agent.run({ input: "independent", onModelCall: async () => "ok" })).state.turnCount,
    ).toBe(1);
  });

  it("keeps scope out of state and events while forwarding it to middleware and tools", async () => {
    const scopes: unknown[] = [],
      events: unknown[] = [];
    const agent = Agent<{ tenantId: string }>({ id: "a", name: "A" })
      .use({
        id: "c",
        tools: [
          {
            name: "t",
            inputSchema: z.object({}),
            execute: async (_, { scope }) => {
              scopes.push(scope);
              return { kind: "completed", output: "done" };
            },
          },
        ],
        middleware: async (request, next) => {
          scopes.push(request.scope);
          return next();
        },
      })
      .build();
    let n = 0;
    const result = await agent.run({
      input: "go",
      scope: { tenantId: "private-principal" },
      onEvent: (event) => {
        events.push(event);
      },
      onModelCall: async (call) => {
        expect(JSON.stringify(call)).not.toContain("private-principal");
        return n++ === 0 ? candidate("t") : "ok";
      },
    });
    expect(result.status).toBe("completed");
    expect(scopes).toEqual([
      { tenantId: "private-principal" },
      { tenantId: "private-principal" },
      { tenantId: "private-principal" },
    ]);
    expect(JSON.stringify([result.state, events])).not.toContain("private-principal");
  });

  it("restores an accepted family binding after discovery changes without rerunning middleware", async () => {
    const used: unknown[] = [];
    const make = (table: string, middlewareSeen: () => void) => {
      const family = defineToolFamily({
        id: "query",
        version: "1",
        bindingSchema: z.object({ table: z.string() }),
        describe: (binding) => ({ name: `query_${binding.table}`, inputSchema: z.object({}) }),
        execute: async (_, { binding, scope }) => {
          used.push({ binding, scope });
          return { kind: "completed", output: "rows" };
        },
      });
      return Agent({ id: "a", name: "A" })
        .use({
          id: "db",
          toolFamilies: [family],
          middleware: async (request, next) => {
            middlewareSeen();
            request.configuration.tools.set("tables", [family.bind({ table })]);
            const response = await next();
            for (const call of response.toolCalls())
              response.requireInteraction(call.id, { kind: "approval", prompt: "Proceed?" });
            return response;
          },
        })
        .build();
    };
    const firstSeen = vi.fn();
    const first = await make("orders", firstSeen).run({
      input: "query",
      onModelCall: async () => candidate("query_orders"),
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("Expected pause");
    const seen = vi.fn();
    const second = await make("customers", seen).run({
      state: roundtrip(first.state),
      input: { kind: "approve", interactionId: first.pending[0]!.interaction!.id, approved: true },
      scope: { tenantId: "fresh" },
      onModelCall: async () => "done",
    });
    expect(second.status).toBe("completed");
    expect(used).toEqual([{ binding: { table: "orders" }, scope: { tenantId: "fresh" } }]);
    expect(seen).toHaveBeenCalledTimes(1); // Only the next model step, never restoration.
  });

  it("restores deferred tools without rerunning already settled siblings", async () => {
    const done = vi.fn(async () => ({ kind: "completed" as const, output: "saved" }));
    const deferred = vi.fn(async () => ({ kind: "deferred" as const, token: { jobId: "123" } }));
    const make = () =>
      Agent({ id: "a", name: "A" })
        .use({
          id: "c",
          tools: [
            { name: "done", inputSchema: z.object({}), execute: done },
            { name: "job", inputSchema: z.object({}), execute: deferred },
          ],
        })
        .build();
    const first = await make().run({
      input: "go",
      onModelCall: async () => ({
        output: [...candidate("done", "d").output, ...candidate("job", "j").output],
      }),
    });
    expect(first.status).toBe("paused");
    if (first.status !== "paused") throw new Error("Expected pause");
    const second = await make().run({
      state: roundtrip(first.state),
      input: {
        kind: "settle",
        invocationId: first.pending[0]!.invocationId,
        outcome: { kind: "completed", output: "finished" },
      },
      onModelCall: async () => "ok",
    });
    expect(second.status).toBe("completed");
    expect(done).toHaveBeenCalledTimes(1);
    expect(deferred).toHaveBeenCalledTimes(1);
    await expect(
      make().run({
        state: second.state,
        input: {
          kind: "settle",
          invocationId: first.pending[0]!.invocationId,
          outcome: { kind: "completed", output: "again" },
        },
        onModelCall: async () => "bad",
      }),
    ).rejects.toMatchObject({ code: "execution.invalid-input" });
  });

  it("isolates bindings across concurrent invocations on the same built agent", async () => {
    const family = defineToolFamily({
      id: "table",
      version: "1",
      bindingSchema: z.object({ table: z.string() }),
      describe: () => ({ name: "query", inputSchema: z.object({}) }),
      execute: async (_, { binding }) => ({ kind: "completed", output: binding.table }),
    });
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const agent = Agent<{ table: string }>({ id: "concurrent", name: "Concurrent" })
      .use({
        id: "db",
        toolFamilies: [family],
        middleware: async (request, next) => {
          request.configuration.tools.set("table", [family.bind({ table: request.scope!.table })]);
          if (++entered === 2) release();
          await bothEntered;
          return next();
        },
      })
      .build();
    const run = (table: string) => {
      let n = 0;
      return agent.run({
        input: "query",
        scope: { table },
        onModelCall: async () => (n++ === 0 ? candidate("query") : "done"),
      });
    };
    const [orders, customers] = await Promise.all([run("orders"), run("customers")]);
    expect(orders.status).toBe("completed");
    expect(customers.status).toBe("completed");
    expect(JSON.stringify(orders.state)).toContain("orders");
    expect(JSON.stringify(orders.state)).not.toContain("customers");
    expect(JSON.stringify(customers.state)).toContain("customers");
    expect(JSON.stringify(customers.state)).not.toContain("orders");
  });

  it("awaits recording before effects and stops on recording failure", async () => {
    const execute = vi.fn(async () => ({ kind: "completed" as const, output: "ok" }));
    const agent = Agent({ id: "a", name: "A" })
      .use({ id: "c", tools: [{ name: "t", inputSchema: z.object({}), execute }] })
      .build();
    await expect(
      agent.run({
        input: "go",
        onModelCall: async () => candidate("t"),
        record: async (state) => {
          if (state.plan) throw new Error("disk full");
        },
      }),
    ).rejects.toMatchObject({ code: "execution.record-failed" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels cooperatively and retains settled tool results", async () => {
    const controller = new AbortController();
    const agent = Agent({ id: "a", name: "A" })
      .use({
        id: "c",
        tools: [
          {
            name: "t",
            inputSchema: z.object({}),
            execute: async (_, { signal }) => {
              expect(signal).toBe(controller.signal);
              controller.abort();
              return { kind: "completed", output: "effect completed" };
            },
          },
        ],
      })
      .build();
    const model = vi.fn(async () => candidate("t"));
    const result = await agent.run({ input: "go", signal: controller.signal, onModelCall: model });
    expect(result.status).toBe("cancelled");
    expect(JSON.stringify(result.state)).toContain("effect completed");
    expect(model).toHaveBeenCalledTimes(1);
  });

  it("validates agent output and rejects incompatible state before model calls", async () => {
    const agent = Agent({
      id: "a",
      name: "A",
      outputSchema: z.object({ count: z.number() }),
    }).build();
    const result = await agent.run({
      input: "go",
      onModelCall: async (call) => {
        expect(call.outputSchema).toBeDefined();
        return { output: [{ type: "json", value: { count: 3 } }] };
      },
    });
    expect(result).toMatchObject({ status: "completed", output: { count: 3 } });
    const invoke = vi.fn(async () => "bad");
    await expect(
      Agent({ id: "a", name: "A", executionVersion: "2" })
        .build()
        .run({ state: result.state, input: "again", onModelCall: invoke }),
    ).rejects.toMatchObject({ code: "execution.incompatible" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

it("rejects obsolete or malformed run controls before effects", async () => {
  const agent = Agent({ id: "a", name: "A" }).build();
  const onModelCall = vi.fn(async () => "unexpected");
  for (const invalid of [
    { outputSchema: {} },
    { onEvent: "bad" },
    { record: "bad" },
    { signal: null },
  ]) {
    await expect(
      agent.run(Object.assign({ input: "go", onModelCall }, invalid) as never),
    ).rejects.toMatchObject({ code: "execution.invalid-input" });
  }
  expect(onModelCall).not.toHaveBeenCalled();
});
