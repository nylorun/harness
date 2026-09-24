/**
 * G5 (CLI) — createClient() without tenant fails before fetch.
 * G7 (CLI) — Host layout credential/dir modes 0600/0700.
 * G3 (CLI) — env change after seed (via ephemeral Host) leaves config unchanged.
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createClient } from "@nylorun/agents";
import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
} from "@nylorun/core/compatibility";
import { startEphemeralRuntime } from "@nylorun/runtime";
import {
  credentialsMode,
  ensureHostCredentials,
  ensureHostLayout,
  hostPaths,
} from "../../src/host/root.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it('G5: createClient() without tenant throws before fetch is called', async () => {
  const calls: string[] = [];
  expect(() =>
    createClient({
      url: "http://127.0.0.1:8787",
      key: "application-key-value",
      fetch: async (input) => {
        calls.push(String(input));
        return new Response("{}");
      },
    }),
  ).toThrow("Set tenant explicitly or via NYLORUN_TENANT");
  expect(calls).toEqual([]);
});

it("G7: host layout dirs are 0700 and host-credentials.json is 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "cli-sec-mode-"));
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  await ensureHostCredentials(paths);

  for (const dir of [
    paths.root,
    paths.home,
    paths.tmp,
    paths.runtime,
    paths.tenants,
    paths.trash,
  ]) {
    const mode = (await stat(dir)).mode & 0o777;
    expect(mode, dir).toBe(0o700);
  }
  expect(credentialsMode(paths)).toBe(0o600);
  expect((await stat(paths.credentials)).mode & 0o777).toBe(0o600);
});

it("G7: project link/credential modes 0600/0700 when written by security fixture", async () => {
  // WS-F owns `.nylorun/link.json` + `credentials.json` writers; until that
  // lands, assert the mode contract on the same paths the Project link will use.
  const project = await mkdtemp(join(tmpdir(), "cli-sec-project-"));
  roots.push(project);
  const nylorun = join(project, ".nylorun");
  await mkdir(nylorun, { recursive: true, mode: 0o700 });
  await writeFile(
    join(nylorun, "link.json"),
    JSON.stringify({
      hostUrl: "http://127.0.0.1:8787",
      hostId: "host_0123456789abcdefghjkmnpq",
      tenantId: "tn_00000000000000000000000001",
    }) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(nylorun, "credentials.json"),
    JSON.stringify({
      applicationKey: "k",
      principalId: "p",
      executors: {},
    }) + "\n",
    { mode: 0o600 },
  );
  expect((await stat(nylorun)).mode & 0o777).toBe(0o700);
  expect((await stat(join(nylorun, "link.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(join(nylorun, "credentials.json"))).mode & 0o777).toBe(
    0o600,
  );
});

it("G3: Tenant seed is insert-if-absent after ambient env changes", async () => {
  const hostRoot = await mkdtemp(join(tmpdir(), "cli-sec-seed-"));
  roots.push(hostRoot);
  const runtime = await startEphemeralRuntime({
    hostRoot,
    baseline: { PATH: process.env.PATH ?? "/usr/bin" },
    model: { kind: "fixture" },
    sandboxBackend: "virtual",
  });
  closers.push(() => runtime.close());

  const headers = {
    authorization: `Bearer ${runtime.applicationKey}`,
    [TENANT_HEADER]: runtime.tenantId,
    [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
    "content-type": "application/json",
  };

  const first = await fetch(`${runtime.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      requestId: randomUUID(),
      sandbox: { backend: "virtual" },
      model: {
        provider: "openai",
        model: "gpt-4o-mini",
        auth: { type: "api_key", key: "sk-cli-seeded" },
      },
    }),
  });
  expect(first.status).toBe(200);

  process.env.OPENAI_API_KEY = "sk-env-after-seed";
  process.env.NYLORUN_SANDBOX = "none";
  process.env.MODEL_PROVIDER_API_KEY = "sk-env-model";

  const second = await fetch(`${runtime.url}/v1/tenant/config/seed`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      requestId: randomUUID(),
      sandbox: { backend: "microsandbox" },
      model: {
        provider: "anthropic",
        model: "claude",
        auth: { type: "api_key", key: "sk-should-not-replace" },
      },
    }),
  });
  expect(second.status).toBe(200);
  const body = (await second.json()) as { applied: string[]; kept: string[] };
  expect(body.applied).toEqual([]);
  expect(body.kept.sort()).toEqual(["model", "sandbox.backend"]);

  const model = await fetch(`${runtime.url}/v1/tenant/model`, { headers });
  const modelText = await model.text();
  expect(modelText).not.toContain("sk-env-after-seed");
  expect(modelText).not.toContain("sk-should-not-replace");
  expect(modelText).not.toContain("sk-cli-seeded");

  delete process.env.OPENAI_API_KEY;
  delete process.env.NYLORUN_SANDBOX;
  delete process.env.MODEL_PROVIDER_API_KEY;
});
