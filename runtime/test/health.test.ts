import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { HealthResponseSchema } from "@nylorun/core/contracts";
import { startRuntime } from "../src/core/runtime.js";
import { RUNTIME_VERSION } from "../src/version.js";

const roots: string[] = [];
const live: { close(): Promise<void> }[] = [];

afterEach(async () => {
  for (const runtime of live.splice(0)) await runtime.close().catch(() => {});
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function host(directory?: string) {
  const root =
    directory ?? (roots.push(await mkdtemp(join(tmpdir(), "health-"))), roots.at(-1)!);
  const runtime = await startRuntime({
    sqlitePath: join(root, "runtime.sqlite"),
    serverToken: "server-token-value",
    executors: [],
    model: async () => ({ output: [{ type: "text", text: "ok" }] }),
    port: 0,
  });
  live.push(runtime);
  return { runtime, root };
}

it("reports the runtime version and scope without authentication", async () => {
  const { runtime } = await host();
  const response = await fetch(`${runtime.url}/health`);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(HealthResponseSchema.parse(body)).toMatchObject({
    status: "ok",
    service: "oss-runtime",
    version: RUNTIME_VERSION,
    pid: process.pid,
  });
  expect(body.scopeId).toMatch(/^[0-9a-f]{16}$/);
});

it("keeps the scope identifier stable per database and free of filesystem paths", async () => {
  const first = await host();
  const second = await host();
  const read = async (url: string) => (await (await fetch(`${url}/health`)).json());
  const a = await read(first.runtime.url);
  const b = await read(second.runtime.url);
  expect(a.scopeId).not.toBe(b.scopeId);

  const text = await (await fetch(`${first.runtime.url}/health`)).text();
  expect(text).not.toContain(homedir());
  expect(text).not.toContain(first.root);

  await first.runtime.close();
  live.splice(live.indexOf(first.runtime), 1);
  const restarted = await host(first.root);
  expect((await read(restarted.runtime.url)).scopeId).toBe(a.scopeId);
});

it("still parses a health payload from a Runtime that predates these fields", () => {
  expect(
    HealthResponseSchema.parse({ status: "ok", service: "oss-runtime" }),
  ).toEqual({ status: "ok", service: "oss-runtime" });
});
