import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { parseStudioArgs } from "../dist/args.js";
import {
  ConnectionMissingError,
  resolveConnection,
} from "../dist/resolve-connection.js";
import {
  StudioRoleError,
  WAITING_MESSAGE,
  waitForApplicationConnection,
} from "../dist/ready.js";
import type { ResolvedConnection } from "@nylorun/agents";

const KEY = "a".repeat(64);
const TENANT = "tn_00000000000000000000000003";
const ENV_KEYS = [
  "NYLORUN_RUNTIME_URL",
  "NYLORUN_TENANT",
  "NYLORUN_SERVER_KEY",
  "NYLORUN_EXECUTOR_KEY",
] as const;

async function withEnv<T>(
  env: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("D1: parseStudioArgs accepts --port, --no-open, and --local-ui", () => {
  assert.deepEqual(parseStudioArgs([]), {
    port: undefined,
    open: true,
    localUi: false,
  });
  assert.deepEqual(parseStudioArgs(["--no-open"]), {
    port: undefined,
    open: false,
    localUi: false,
  });
  assert.deepEqual(parseStudioArgs(["--port", "4199"]), {
    port: 4199,
    open: true,
    localUi: false,
  });
  assert.deepEqual(parseStudioArgs(["--port", "4199", "--no-open"]), {
    port: 4199,
    open: false,
    localUi: false,
  });
  assert.deepEqual(parseStudioArgs(["--local-ui", "--no-open"]), {
    port: undefined,
    open: false,
    localUi: true,
  });
});

test("D2: resolveConnection options and environment; rejects mixing", async () => {
  await withEnv({}, async () => {
    const fromOptions = await resolveConnection({
      url: "http://127.0.0.1:8787/",
      tenant: TENANT,
      key: KEY,
    });
    assert.deepEqual(fromOptions, {
      url: "http://127.0.0.1:8787",
      tenant: TENANT,
      key: KEY,
      role: "application",
      source: "options",
    });

    await assert.rejects(
      () =>
        resolveConnection({
          url: "http://127.0.0.1:8787",
        }),
      ConnectionMissingError,
    );
  });

  await withEnv(
    {
      NYLORUN_RUNTIME_URL: "http://127.0.0.1:9000",
      NYLORUN_TENANT: TENANT,
      NYLORUN_SERVER_KEY: KEY,
    },
    async () => {
      const fromEnv = await resolveConnection({ cwd: "/tmp" });
      assert.equal(fromEnv.source, "environment");
      assert.equal(fromEnv.role, "application");
    },
  );

  await withEnv(
    {
      NYLORUN_RUNTIME_URL: "http://127.0.0.1:9000",
      NYLORUN_TENANT: TENANT,
      NYLORUN_EXECUTOR_KEY: KEY,
    },
    async () => {
      const executor = await resolveConnection({ cwd: "/tmp" });
      assert.equal(executor.role, "executor");
    },
  );
});

test("D2: resolveConnection finds project-link from a nested directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylo-studio-link-"));
  const nested = join(root, "apps", "demo");
  await mkdir(join(root, ".nylorun"), { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(root, ".nylorun/link.json"),
    JSON.stringify({
      format: 1,
      hostUrl: "http://127.0.0.1:8787",
      hostId: "host_1",
      tenantId: TENANT,
    }),
  );
  await writeFile(
    join(root, ".nylorun/credentials.json"),
    JSON.stringify({
      format: 1,
      applicationKey: KEY,
      principalId: "pr_1",
    }),
  );
  await withEnv({}, async () => {
    const connection = await resolveConnection({ cwd: nested });
    assert.deepEqual(connection, {
      url: "http://127.0.0.1:8787",
      tenant: TENANT,
      key: KEY,
      role: "application",
      source: "project-link",
    });
  });
});

test("D2/D3: wait rejects executor role; waits for health; prints once", async () => {
  await assert.rejects(
    () =>
      waitForApplicationConnection({
        resolveConnection: async () =>
          ({
            url: "http://127.0.0.1:1",
            tenant: TENANT,
            key: KEY,
            role: "executor",
            source: "environment",
          }) satisfies ResolvedConnection,
        fetchHealth: async () => true,
        sleep: async () => {
          throw new Error("should not sleep after executor rejection");
        },
        log: () => {
          throw new Error("should not wait for executor");
        },
      }),
    (error: unknown) =>
      error instanceof StudioRoleError &&
      /application connection/i.test(error.message),
  );

  const messages: string[] = [];
  let attempts = 0;
  const connection = await waitForApplicationConnection({
    intervalMs: 1,
    log: (message) => messages.push(message),
    sleep: async () => undefined,
    resolveConnection: async () => {
      attempts += 1;
      if (attempts < 3)
        throw new ConnectionMissingError("connection_missing: not yet");
      return {
        url: "http://127.0.0.1:8787",
        tenant: TENANT,
        key: KEY,
        role: "application",
        source: "project-link",
      };
    },
    fetchHealth: async () => attempts >= 4,
  });
  assert.equal(connection.tenant, TENANT);
  assert.deepEqual(messages, [WAITING_MESSAGE]);
  assert.ok(attempts >= 4);
});

test("D4: wait + startStudio never writes under .nylorun and never calls Admin", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylo-studio-ro-"));
  await mkdir(join(root, ".nylorun"), { recursive: true });
  const linkBody = `${JSON.stringify({
    format: 1,
    hostUrl: "http://127.0.0.1:8787",
    hostId: "host_1",
    tenantId: TENANT,
  })}\n`;
  const credBody = `${JSON.stringify({
    format: 1,
    applicationKey: KEY,
    principalId: "pr_1",
  })}\n`;
  await writeFile(join(root, ".nylorun/link.json"), linkBody);
  await writeFile(join(root, ".nylorun/credentials.json"), credBody);

  const upstreamHits: string[] = [];
  const upstream = createServer((req, res) => {
    upstreamHits.push(req.url ?? "");
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "nylorun-runtime" }));
      return;
    }
    res.writeHead(404);
    res.end("no");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const runtimeUrl = `http://127.0.0.1:${address.port}`;

  await writeFile(
    join(root, ".nylorun/link.json"),
    `${JSON.stringify({
      format: 1,
      hostUrl: runtimeUrl,
      hostId: "host_1",
      tenantId: TENANT,
    })}\n`,
  );

  const before = await snapshotNylorun(join(root, ".nylorun"));
  const { startStudio } = await import("../dist/host.js");
  const connection = await withEnv({}, () =>
    waitForApplicationConnection({
      intervalMs: 1,
      sleep: async () => undefined,
      resolveConnection: () => resolveConnection({ cwd: root }),
    }),
  );
  assert.equal(connection.role, "application");
  assert.ok(!upstreamHits.some((path) => path.includes("/v1/admin")));

  const studio = await startStudio({
    runtimeUrl: connection.url,
    serverKey: connection.key,
    tenant: { id: connection.tenant, name: connection.tenant },
    open: false,
    port: 0,
  });
  try {
    assert.ok(!upstreamHits.some((path) => path.includes("/v1/admin")));
    const after = await snapshotNylorun(join(root, ".nylorun"));
    assert.deepEqual(after, before);
  } finally {
    await studio.close();
    upstream.close();
  }
});

async function snapshotNylorun(dir: string) {
  const entries = await readdir(dir);
  const out: Record<string, { size: number; mtimeMs: number; body?: string }> =
    {};
  for (const name of entries) {
    const path = join(dir, name);
    const info = await stat(path);
    out[name] = {
      size: info.size,
      mtimeMs: info.mtimeMs,
      body: info.isFile() ? await readFile(path, "utf8") : undefined,
    };
  }
  return out;
}
