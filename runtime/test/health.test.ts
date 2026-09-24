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

// TENANTS-W0: HealthResponseSchema no longer accepts scopeId; Host /health lands in WS-C.
it.todo("reports the runtime version and scope without authentication");

it.todo(
  "keeps the scope identifier stable per database and free of filesystem paths",
);

it.todo("still parses a health payload from a Runtime that predates these fields");

// Keep helpers referenced so the file typechecks until WS-C rewrites these tests.
void host;
void HealthResponseSchema;
void RUNTIME_VERSION;
void expect;
void homedir;
