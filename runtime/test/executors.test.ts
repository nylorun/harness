import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { startRuntime, type CoreRuntime } from "../src/core/runtime.js";

const SERVER = "server-token-value";
const roots: string[] = [];
const live: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const runtime of live.splice(0)) await runtime.close().catch(() => {});
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function host(
  options: { executors?: { token: string; agentId: string; implementationVersion: string }[]; directory?: string } = {},
) {
  const directory =
    options.directory ?? (roots.push(await mkdtemp(join(tmpdir(), "executors-"))), roots.at(-1)!);
  const runtime = await startRuntime({
    sqlitePath: join(directory, "runtime.sqlite"),
    serverToken: SERVER,
    executors: options.executors ?? [],
    model: async () => ({ output: [{ type: "text", text: "ok" }] }),
    port: 0,
  });
  live.push(runtime);
  return { runtime: runtime as CoreRuntime & { url: string }, directory };
}

const register = (url: string, body: unknown, key = SERVER) =>
  fetch(`${url}/v1/executors`, {
    method: "PUT",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const one = (token: string, agentId = "issue") => ({
  executors: [{ token, agentId, implementationVersion: "dev" }],
});

const connect = (url: string, token: string) =>
  fetch(`${url}/v1/executors/connect`, {
    headers: { authorization: `Bearer ${token}` },
  });

it("registers an executor that can immediately open the work stream", async () => {
  const { runtime } = await host();
  const response = await register(runtime.url, one("registered-token-value"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    executors: [{ agentId: "issue", implementationVersion: "dev", rotated: false }],
  });
  const stream = await connect(runtime.url, "registered-token-value");
  expect(stream.status).toBe(200);
  await stream.body?.cancel();
});

it("requires the application credential", async () => {
  const { runtime } = await host({
    executors: [{ token: "executor-token-value", agentId: "issue", implementationVersion: "dev" }],
  });
  expect((await register(runtime.url, one("another-token-value"), "executor-token-value")).status).toBe(403);
  expect((await register(runtime.url, one("another-token-value"), "wrong-token-value")).status).toBe(401);
  expect(
    (await fetch(`${runtime.url}/v1/executors`, { method: "PUT", body: "{}" })).status,
  ).toBe(401);
});

it("rejects credentials that are weak, shared with the server, or duplicated", async () => {
  const { runtime } = await host();
  expect((await register(runtime.url, one("short"))).status).toBe(400);
  expect((await register(runtime.url, one(SERVER))).status).toBe(400);
  const duplicate = await register(runtime.url, {
    executors: [
      { token: "shared-token-value-a", agentId: "one", implementationVersion: "dev" },
      { token: "shared-token-value-a", agentId: "two", implementationVersion: "dev" },
    ],
  });
  expect(duplicate.status).toBe(400);
  const listed = await fetch(`${runtime.url}/v1/executors`, {
    headers: { authorization: `Bearer ${SERVER}` },
  });
  expect((await listed.json()).executors).toEqual([]);
});

it("treats an unchanged registration as idempotent and leaves the stream open", async () => {
  const { runtime } = await host();
  await register(runtime.url, one("registered-token-value"));
  const stream = await connect(runtime.url, "registered-token-value");
  const reader = stream.body!.getReader();
  await reader.read();
  const again = await register(runtime.url, one("registered-token-value"));
  expect((await again.json()).executors[0].rotated).toBe(false);
  await register(runtime.url, one("registered-token-value"));
  expect((await connect(runtime.url, "registered-token-value")).status).toBe(200);
  await reader.cancel();
});

it("drops the replaced stream and invalidates the old token on rotation", async () => {
  const { runtime } = await host();
  await register(runtime.url, one("first-token-value-aaa"));
  const stream = await connect(runtime.url, "first-token-value-aaa");
  const reader = stream.body!.getReader();
  await reader.read();
  const rotated = await register(runtime.url, one("second-token-value-bb"));
  expect((await rotated.json()).executors[0].rotated).toBe(true);
  // The replaced connection ends rather than lingering with a revoked credential.
  let done = false;
  for (let i = 0; i < 40 && !done; i++) done = (await reader.read()).done;
  expect(done).toBe(true);
  expect((await connect(runtime.url, "first-token-value-aaa")).status).toBe(401);
  expect((await connect(runtime.url, "second-token-value-bb")).status).toBe(200);
});

it("does not treat a PUT to the connect route as a registration", async () => {
  const { runtime } = await host();
  const response = await fetch(`${runtime.url}/v1/executors/connect`, {
    method: "PUT",
    headers: { authorization: `Bearer ${SERVER}`, "content-type": "application/json" },
    body: JSON.stringify(one("registered-token-value")),
  });
  expect(response.status).toBe(404);
});

it("deletes a registered executor and refuses to delete an environment-provided one", async () => {
  const { runtime } = await host({
    executors: [{ token: "environment-token-value", agentId: "seeded", implementationVersion: "dev" }],
  });
  await register(runtime.url, one("registered-token-value"));
  const remove = (agentId: string) =>
    fetch(`${runtime.url}/v1/executors/${agentId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${SERVER}` },
    });
  expect((await remove("issue")).status).toBe(200);
  expect((await connect(runtime.url, "registered-token-value")).status).toBe(401);
  expect((await remove("issue")).status).toBe(404);
  expect((await remove("seeded")).status).toBe(409);
});

it("keeps registrations across a restart and hashes tokens at rest", async () => {
  const { runtime, directory } = await host();
  await register(runtime.url, one("persisted-token-value"));
  await runtime.close();
  live.length = 0;

  const database = new DatabaseSync(join(directory, "runtime.sqlite"));
  const rows = database.prepare("SELECT agent_id,token_hash FROM executors").all();
  expect(rows).toHaveLength(1);
  expect(String(rows[0]!.token_hash)).not.toBe("persisted-token-value");
  database.close();

  const restarted = await host({ directory });
  expect((await connect(restarted.runtime.url, "persisted-token-value")).status).toBe(200);
});

it("lets an environment scope shadow a persisted one without rewriting the row", async () => {
  const { runtime, directory } = await host();
  await register(runtime.url, one("persisted-token-value"));
  await runtime.close();
  live.length = 0;

  const restarted = await host({
    directory,
    executors: [{ token: "environment-token-value", agentId: "issue", implementationVersion: "dev" }],
  });
  expect((await connect(restarted.runtime.url, "environment-token-value")).status).toBe(200);
  expect((await connect(restarted.runtime.url, "persisted-token-value")).status).toBe(401);
  await restarted.runtime.close();
  live.length = 0;

  const database = new DatabaseSync(join(directory, "runtime.sqlite"));
  const rows = database.prepare("SELECT token_hash FROM executors").all();
  database.close();
  const reopened = await host({ directory });
  expect((await connect(reopened.runtime.url, "persisted-token-value")).status).toBe(200);
  expect(rows).toHaveLength(1);
});

it("never discloses tokens through the executor listing", async () => {
  const { runtime } = await host();
  await register(runtime.url, one("registered-token-value"));
  const response = await fetch(`${runtime.url}/v1/executors`, {
    headers: { authorization: `Bearer ${SERVER}` },
  });
  const text = await response.text();
  expect(text).not.toContain("registered-token-value");
  expect(text).not.toContain("tokenHash");
  expect(JSON.parse(text).executors).toEqual([
    {
      agentId: "issue",
      implementationVersion: "dev",
      connected: false,
      updatedAt: expect.any(String),
    },
  ]);
});
