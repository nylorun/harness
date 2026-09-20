import { describe, it, expect, vi } from "vitest";
import { Agent } from "@nylorun/harness";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Runtime,
  serveAgents,
  memorySessions,
  SessionHost,
  type StoredSession,
} from "./legacy-api.js";
import { localSessions } from "../src/node/local-sessions.js";
import { Hono } from "hono";

describe("session stores", () => {
  for (const kind of ["memory", "local"] as const)
    it(`${kind} stores isolated atomic documents`, async () => {
      const root = await mkdtemp(join(tmpdir(), "nylorun-store-"));
      const store =
        kind === "local" ? localSessions({ root }) : memorySessions();
      try {
        const document: StoredSession = {
          version: 1,
          id: "s",
          agentId: "a",
          status: "completed",
          startedAt: 1,
          updatedAt: 2,
          events: [],
        };
        expect(await store.get("a", "s")).toBeUndefined();
        await store.put("a", "s", document);
        expect(await store.get("a", "s")).toEqual(document);
        expect(await store.list("a")).toMatchObject([
          { session: "s", status: "completed" },
        ]);
        expect(await store.list("other")).toEqual([]);
      } finally {
        if ("close" in store) await store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  it("rejects a second local owner and reopens after orderly shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "nylorun-lock-"));
    const first = localSessions({ root });
    await first.list("a");
    const second = localSessions({ root });
    await expect(second.list("a")).rejects.toThrow("already has an owner");
    await first.close();
    const reopened = localSessions({ root });
    await reopened.list("a");
    await reopened.close();
    await rm(root, { recursive: true, force: true });
  });
});

describe("session host", () => {
  it("serializes submissions and restores state through a fresh host", async () => {
    const store = memorySessions();
    const host = new SessionHost(store);
    const agent = Agent({ id: "a", name: "A" }).build();
    const seen: string[] = [];
    const onModelCall = async () => {
      seen.push("start");
      await new Promise((resolve) => setTimeout(resolve, 3));
      seen.push("end");
      return "ok";
    };
    await Promise.all([
      host.submit(agent, "s", "first", { onModelCall }),
      host.submit(agent, "s", "second", { onModelCall }),
    ]);
    expect(seen).toEqual(["start", "end", "start", "end"]);
    expect((await store.get("a", "s"))?.state?.turnCount).toBe(2);
    const fresh = new SessionHost(store);
    await fresh.submit(agent, "s", "third", { onModelCall });
    expect((await store.get("a", "s"))?.state?.turnCount).toBe(3);
  });
  it("leaves an active marker on recording failure and never automatically replays", async () => {
    const memory = memorySessions();
    let writes = 0;
    const store = {
      ...memory,
      put: async (...args: Parameters<typeof memory.put>) => {
        if (++writes === 2) throw new Error("disk failed");
        await memory.put(...args);
      },
    };
    const agent = Agent({ id: "a", name: "A" }).build();
    const model = vi.fn(async () => "ok");
    await expect(
      new SessionHost(store).submit(agent, "s", "first", {
        onModelCall: model,
      }),
    ).rejects.toThrow("Recording failed");
    expect((await new SessionHost(memory).read("a", "s"))?.status).toBe(
      "interrupted",
    );
    expect(await new SessionHost(memory).list("a")).toMatchObject([
      { status: "interrupted" },
    ]);
    await expect(
      new SessionHost(memory).submit(agent, "s", "retry", {
        onModelCall: model,
      }),
    ).rejects.toThrow("interrupted");
    expect(model).not.toHaveBeenCalled();
  });
  it("returns streaming response before model completes and persists final history", async () => {
    let resolve!: (text: string) => void;
    const waiting = new Promise<string>((done) => {
      resolve = done;
    });
    const runtime = new Runtime({ onModelCall: () => waiting });
    const app = new Hono().route(
      "/agents",
      serveAgents({ runtime, agents: [Agent({ id: "a", name: "A" }).build()] }),
    );
    const response = await app.request("/agents/a/v1/ag-ui", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId: "s",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("RUN_STARTED");
    resolve("finished");
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += new TextDecoder().decode(chunk.value);
    }
    expect(rest).toContain("finished");
    expect(rest).toContain("RUN_FINISHED");
    expect((await runtime.host.read("a", "s"))?.status).toBe("completed");
    await runtime.close();
  });
});

it("interrupts active work, discards queued inputs, and starts replacement only after settlement", async () => {
  const host = new SessionHost(memorySessions());
  const agent = Agent({ id: "a", name: "A" }).build();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const order: string[] = [];
  const first = host.submit(agent, "s", "first", {
    onModelCall: async (_, { signal }) => {
      started();
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push("settled");
      return "abandoned";
    },
  });
  await ready;
  const queued = host.submit(agent, "s", "queued", {
    onModelCall: async () => {
      order.push("unexpected");
      return "queued";
    },
  });
  const rejected = expect(queued).rejects.toThrow("cancelled");
  const replacement = await host.interrupt(agent, "s", "replacement", {
    onModelCall: async () => {
      order.push("replacement");
      return "ok";
    },
  });
  await rejected;
  expect((await first).status).toBe("cancelled");
  expect(replacement.status).toBe("completed");
  expect(order).toEqual(["settled", "replacement"]);
  await host.close();
});

it("does not publish terminal success until the session document commits", async () => {
  const memory = memorySessions();
  const observed: string[] = [];
  const host = new SessionHost({
    ...memory,
    put: async (a, s, value) => {
      if (value.status === "completed")
        throw new Error("terminal write failed");
      await memory.put(a, s, value);
    },
  });
  await expect(
    host.submit(Agent({ id: "a", name: "A" }).build(), "s", "go", {
      onModelCall: async () => "done",
      onEvent: (event) => observed.push(event.type),
    }),
  ).rejects.toThrow("terminal write failed");
  expect(observed).not.toContain("final");
  expect((await host.read("a", "s"))?.status).toBe("interrupted");
});

it.each(["cancel", "close"] as const)(
  "honors %s while a session is loading",
  async (action) => {
    const memory = memorySessions();
    let loading!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      loading = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const put = vi.fn(memory.put);
    const host = new SessionHost({
      ...memory,
      put,
      get: async () => {
        loading();
        await waiting;
        return undefined;
      },
    });
    const model = vi.fn(async () => "unexpected");
    const run = host.submit(Agent({ id: "a", name: "A" }).build(), "s", "go", {
      onModelCall: model,
    });
    const rejected = expect(run).rejects.toThrow(
      action === "cancel" ? "cancelled" : "closed",
    );
    await started;
    const stopped =
      action === "cancel"
        ? host.cancel(Agent({ id: "a", name: "A" }).build(), "s")
        : host.close();
    release();
    await Promise.all([rejected, stopped]);
    expect(put).not.toHaveBeenCalled();
    expect(model).not.toHaveBeenCalled();
  },
);

it("rejects another process and stops after local ownership changes", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { writeFile, readFile } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "nylorun-process-lock-"));
  const store = localSessions({ root });
  try {
    await store.list("a");
    const script = `import {localSessions} from './dist/node/index.js'; const store=localSessions({root:process.argv[1]}); try {await store.list('a');process.exitCode=1;} catch(error) {process.stdout.write(error.message);}`;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      script,
      root,
    ]);
    expect(stdout).toContain("already has an owner");
    await writeFile(
      join(root, ".owner.lock"),
      JSON.stringify({ token: "another-owner", pid: -1 }),
    );
    await expect(
      store.put("a", "s", {
        version: 1,
        id: "s",
        agentId: "a",
        status: "completed",
        startedAt: 1,
        updatedAt: 1,
        events: [],
      }),
    ).rejects.toThrow("ownership was lost");
    await expect(store.close()).rejects.toThrow("ownership was lost");
    expect(await readFile(join(root, ".owner.lock"), "utf8")).toContain(
      "another-owner",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("interrupts a saved pause through a fresh host before accepting a replacement", async () => {
  const { z } = await import("zod");
  const execute = vi.fn(async () => ({
    kind: "deferred" as const,
    token: "original job",
  }));
  const agent = Agent({ id: "a", name: "A" })
    .use({
      id: "tools",
      tools: [{ name: "job", inputSchema: z.object({}), execute }],
    })
    .build();
  const store = memorySessions();
  const first = await new SessionHost(store).submit(agent, "s", "start job", {
    onModelCall: async () => ({
      output: [{ type: "tool-call", id: "job", name: "job", args: {} }],
    }),
  });
  expect(first.status).toBe("paused");
  const host = new SessionHost(store);
  const observed: string[] = [];
  host.subscribe("a", "s", (event) => {
    observed.push(event.type);
  });
  const replacement = await host.interrupt(agent, "s", "new question", {
    onModelCall: async (call) => {
      expect(JSON.stringify(call)).not.toContain("original job");
      return "replacement";
    },
  });
  expect(replacement).toMatchObject({
    status: "completed",
    output: "replacement",
  });
  expect(replacement.state.turnCount).toBe(2);
  expect(JSON.stringify(replacement.state)).toContain("original job");
  expect(execute).toHaveBeenCalledOnce();
  expect(observed.indexOf("cancelled")).toBeLessThan(
    observed.indexOf("session.run.started"),
  );
  expect((await store.get("a", "s"))?.status).toBe("completed");
  await host.close();
});

it("preserves a pause and monotonic event history after a rejected continuation", async () => {
  const { z } = await import("zod");
  const agent = Agent({ id: "a", name: "A" })
    .use({
      id: "tools",
      tools: [
        {
          name: "job",
          inputSchema: z.object({}),
          execute: async () => ({ kind: "deferred", token: "job" }),
        },
      ],
    })
    .build();
  const store = memorySessions();
  const host = new SessionHost(store);
  const observed: number[] = [];
  host.subscribe("a", "s", (event) => {
    observed.push(event.seq);
  });
  const first = await host.submit(agent, "s", "go", {
    onModelCall: async () => ({
      output: [{ type: "tool-call", id: "c", name: "job", args: {} }],
    }),
  });
  if (first.status !== "paused") throw new Error("Expected pause");
  const model = vi.fn(async () => "done");
  await expect(
    host.submit(
      agent,
      "s",
      {
        kind: "settle",
        invocationId: "wrong",
        outcome: { kind: "completed", output: "bad" },
      },
      { onModelCall: model },
    ),
  ).rejects.toThrow();
  expect((await store.get("a", "s"))?.state).toEqual(first.state);
  expect(model).not.toHaveBeenCalled();
  await host.submit(
    agent,
    "s",
    {
      kind: "settle",
      invocationId: first.pending[0]!.invocationId,
      outcome: { kind: "completed", output: "valid" },
    },
    { onModelCall: model },
  );
  expect(observed).toEqual([...new Set(observed)].sort((a, b) => a - b));
  expect((await store.get("a", "s"))?.events.map((event) => event.seq)).toEqual(
    observed,
  );
  await host.close();
});
