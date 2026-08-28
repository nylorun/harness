import { describe, expect, it, vi } from "vitest";
import { createAdapterRegistry } from "../src/build/adapters.js";
import { Agent } from "../src/index.js";
import { adapter, model, offer, tool, toolCalls, turn } from "./fixtures.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("adapter concurrency", () => {
  it("shares an adapter limit across Sessions from one BuiltAgent", async () => {
    const pending: ReturnType<typeof deferred<{ kind: "completed"; output: string }>>[] = [];
    let active = 0;
    let peak = 0;
    const local = adapter(async () => {
      active += 1;
      peak = Math.max(peak, active);
      const next = deferred<{ kind: "completed"; output: string }>();
      pending.push(next);
      return next.promise.finally(() => {
        active -= 1;
      });
    });
    const agent = Agent(
      model(async (_call, { request }) =>
        request.toolResults.length
          ? "done"
          : toolCalls({ id: `call-${request.sessionId}`, name: "echo", args: {} }),
      ),
    )
      .with(local, { maxConcurrentCalls: 1 })
      .use("tools", offer(tool()))
      .build();

    const first = turn(agent, "first");
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = turn(agent, "second");
    await Promise.resolve();
    expect(pending).toHaveLength(1);

    pending[0]!.resolve({ kind: "completed", output: "first" });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!.resolve({ kind: "completed", output: "second" });

    await expect(first.handle.completed).resolves.toMatchObject({ status: "completed" });
    await expect(second.handle.completed).resolves.toMatchObject({ status: "completed" });
    expect(peak).toBe(1);
  });

  it("removes an aborted queued permit request without blocking later work", async () => {
    const first = deferred<string>();
    const registry = createAdapterRegistry([
      {
        adapter: {
          id: "local",
          execute: async () => ({ kind: "completed" as const, output: "ok" }),
        },
        options: { maxConcurrentCalls: 1 },
      },
    ]);
    const firstRun = registry.execute("local", new AbortController().signal, () => first.promise);
    const queuedController = new AbortController();
    const queued = registry.execute("local", queuedController.signal, async () => "queued");
    queuedController.abort(new Error("cancelled"));
    await expect(queued).rejects.toThrow("cancelled");

    first.resolve("first");
    await expect(firstRun).resolves.toBe("first");
    await expect(
      registry.execute("local", new AbortController().signal, async () => "later"),
    ).resolves.toBe("later");
  });
});
