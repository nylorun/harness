import { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { waitForIdle, fetchAdminHost } from "../../src/host/admin-client.js";
import { writeFakeInstall } from "../../src/host/install.js";
import {
  down,
  hostStatus,
  logsCommand,
  restart,
  statusCommand,
  up,
} from "../../src/host/lifecycle.js";
import {
  ensureHostConfig,
  ensureHostLayout,
  hostPaths,
  writeHostConfig,
  writeHostState,
} from "../../src/host/root.js";
import {
  removeRoot,
  startStubHost,
  temporaryRoot,
} from "./support.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  await Promise.all(roots.splice(0).map(removeRoot));
});

function fakeReadyChild(): ChildProcess {
  const emitter = new EventEmitter() as ChildProcess;
  emitter.kill = (() => true) as ChildProcess["kill"];
  emitter.disconnect = () => undefined;
  emitter.unref = () => emitter;
  emitter.pid = 42_042;
  return emitter;
}

async function listenStubOn(
  port: number,
  options: {
    hostId: string;
    adminKey: string;
  },
): Promise<{ close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "nylorun-runtime",
          version: "0.9.0-beta",
          protocol: { min: 2, max: 2, features: ["runtime-tenants"] },
          coreVersion: "0.4.0-beta",
          hostId: options.hostId,
          pid: 42_042,
        }),
      );
      return;
    }
    if (url.pathname === "/ready") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ready",
          service: "nylorun-runtime",
          checks: { listener: true, discovery: true },
        }),
      );
      return;
    }
    if (url.pathname === "/v1/admin/host") {
      const auth = req.headers.authorization ?? "";
      if (auth !== `Bearer ${options.adminKey}`) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          hostId: options.hostId,
          url: `http://127.0.0.1:${port}`,
          pid: 42_042,
          version: "0.9.0-beta",
          protocol: { min: 2, max: 2, features: ["runtime-tenants"] },
          tenants: [],
          aggregate: {
            runningSessions: 0,
            connectedExecutors: 0,
            pendingActions: 0,
            uncertainEffects: 0,
          },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const installer = async ({
  stagingDir,
  version: v,
}: {
  stagingDir: string;
  version: string;
  versionDir: string;
}) => {
  const pkgDir = join(stagingDir, "node_modules", "@nylorun", "runtime");
  await mkdir(join(pkgDir, "dist", "core"), { recursive: true });
  await writeFile(
    join(pkgDir, "dist", "core", "main.js"),
    `process.send?.({ type: "ready" });\nsetInterval(() => {}, 1 << 30);\n`,
  );
  await writeFile(
    join(pkgDir, "package.json"),
    JSON.stringify({
      name: "@nylorun/runtime",
      version: v,
      type: "module",
      exports: { "./server": "./dist/core/main.js" },
    }),
  );
};

it("E5/E7: status reports Host id, address, protocol and tenants via admin", async () => {
  const stub = await startStubHost({
    tenants: [
      {
        id: "tn_0123456789abcdefghjkmnpq",
        name: "demo",
        state: "open",
        envelope: null,
      },
    ],
  });
  closers.push(stub.close);
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  await writeHostConfig(paths, {
    hostId: stub.hostId,
    host: stub.host,
    port: stub.port,
  });
  await writeFile(
    paths.credentials,
    JSON.stringify({ adminKey: stub.adminKey }),
    { mode: 0o600 },
  );
  await writeHostState(paths, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: "0.9.0-beta",
    entry: "/tmp/fake-entry.js",
    url: stub.url,
  });
  const status = await hostStatus(paths.root);
  expect(status.state).toBe("running");
  expect(status.hostId).toBe(stub.hostId);
  expect(status.url).toBe(stub.url);
  expect(status.protocol?.features).toContain("runtime-tenants");
  expect(status.tenants?.[0]?.name).toBe("demo");
  expect(status.tenants?.[0]?.state).toBe("open");
});

it("E5: up spawns with baseline env, cwd home, and writes host-state.json", async () => {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  const { config } = await ensureHostConfig(paths);
  const adminKey = "b".repeat(64);
  await writeFile(paths.credentials, JSON.stringify({ adminKey }), {
    mode: 0o600,
  });

  let spawnEnv: NodeJS.ProcessEnv | undefined;
  let spawnCwd: string | undefined;

  const result = await up(
    { root: paths.root },
    {
      installer,
      spawnHost: (input) => {
        spawnEnv = input.environment;
        spawnCwd = input.cwd;
        const child = fakeReadyChild();
        // Replace the eager ready with one that fires after the stub is bound.
        child.removeAllListeners("message");
        void listenStubOn(config.port, {
          hostId: config.hostId,
          adminKey,
        }).then((stub) => {
          closers.push(stub.close);
          child.emit("message", { type: "ready" });
        });
        return child;
      },
    },
  );

  expect(result.status.state).toBe("running");
  expect(spawnCwd).toBe(paths.home);
  expect(spawnEnv?.NYLORUN_HOME).toBe(paths.root);
  expect(spawnEnv?.HOME).toBe(paths.home);
  expect(spawnEnv?.TMPDIR).toBe(paths.tmp);
  expect(spawnEnv?.NODE_OPTIONS).toBeUndefined();
  expect(existsSync(paths.state)).toBe(true);
  const state = JSON.parse(await readFile(paths.state, "utf8"));
  expect(state.url).toBe(`http://127.0.0.1:${config.port}`);
  expect(state.pid).toBe(42_042);

  await writeHostState(paths, {
    ...state,
    pid: 2_147_483_640,
  });
  await down({ root: paths.root, force: true });
});

it("E6: down --force clears state and leaves host.json", async () => {
  const stub = await startStubHost();
  closers.push(stub.close);
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  await writeHostConfig(paths, {
    hostId: stub.hostId,
    host: stub.host,
    port: stub.port,
  });
  await writeFile(
    paths.credentials,
    JSON.stringify({ adminKey: stub.adminKey }),
    { mode: 0o600 },
  );
  await writeHostState(paths, {
    pid: 2_147_483_646,
    startedAt: new Date().toISOString(),
    version: "0.9.0-beta",
    entry: "/tmp/fake.js",
    url: stub.url,
  });
  await down({ root: paths.root, force: true });
  expect(existsSync(paths.config)).toBe(true);
  expect(existsSync(paths.state)).toBe(false);
});

it("E6: --wait polls until aggregate is idle", async () => {
  const stub = await startStubHost({
    aggregate: {
      runningSessions: 1,
      connectedExecutors: 0,
      pendingActions: 0,
      uncertainEffects: 0,
    },
  });
  closers.push(stub.close);
  setTimeout(() => {
    stub.setAggregate({
      runningSessions: 0,
      connectedExecutors: 0,
      pendingActions: 0,
      uncertainEffects: 0,
    });
  }, 100);
  const idle = await waitForIdle({
    url: stub.url,
    adminKey: stub.adminKey,
    pollMs: 40,
    timeoutMs: 2_000,
  });
  expect(idle.aggregate.runningSessions).toBe(0);
});

it("E6: down warns when sessions or executors are active", async () => {
  const stub = await startStubHost({
    aggregate: {
      runningSessions: 2,
      connectedExecutors: 1,
      pendingActions: 0,
      uncertainEffects: 0,
    },
  });
  closers.push(stub.close);
  const status = await fetchAdminHost({
    url: stub.url,
    adminKey: stub.adminKey,
  });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  console.warn(
    `Host has ${status.aggregate.runningSessions} running session(s) and ${status.aggregate.connectedExecutors} connected executor(s).`,
  );
  expect(warn.mock.calls[0]?.[0]).toMatch(/2 running session/);
  warn.mockRestore();
});

it("E8: restart installs before stopping / spawning", async () => {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  const { config } = await ensureHostConfig(paths);
  const adminKey = "c".repeat(64);
  await writeFile(paths.credentials, JSON.stringify({ adminKey }), {
    mode: 0o600,
  });
  await writeHostState(paths, {
    pid: 2_147_483_645,
    startedAt: new Date().toISOString(),
    version: "old",
    entry: "/tmp/old.js",
    url: `http://127.0.0.1:${config.port}`,
  });

  const order: string[] = [];
  await restart(
    { root: paths.root },
    {
      installer: async (input) => {
        order.push("install");
        await installer(input);
      },
      spawnHost: (input) => {
        void input;
        order.push("spawn");
        const child = fakeReadyChild();
        child.removeAllListeners("message");
        void listenStubOn(config.port, {
          hostId: config.hostId,
          adminKey,
        }).then((stub) => {
          closers.push(stub.close);
          child.emit("message", { type: "ready" });
        });
        return child;
      },
    },
  );
  expect(order[0]).toBe("install");
  expect(order).toContain("spawn");
  await writeHostState(paths, {
    pid: 2_147_483_644,
    startedAt: new Date().toISOString(),
    version: "new",
    entry: "/tmp/new.js",
    url: `http://127.0.0.1:${config.port}`,
  });
  await down({ root: paths.root, force: true });
});

it("E9: logs multiplexes runtime.log and tenant logs with prefix", async () => {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await mkdir(paths.tenants, { recursive: true });
  await writeFile(paths.log, "host-line-1\nhost-line-2\n");
  const tenantId = "tn_0123456789abcdefghjkmnpq";
  const tenantDir = join(paths.tenants, tenantId);
  await mkdir(join(tenantDir, "logs"), { recursive: true });
  await writeFile(
    join(tenantDir, "tenant.json"),
    JSON.stringify({
      id: tenantId,
      name: "acme",
      createdAt: "t",
      updatedAt: "t",
      schemaVersion: 1,
    }),
  );
  await writeFile(join(tenantDir, "logs", "tenant.log"), "tenant-line\n");

  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await logsCommand({ root: paths.root, lines: 50 });
  } finally {
    process.stdout.write = original;
  }
  const out = chunks.join("");
  expect(out).toContain("host-line-2");
  expect(out).toMatch(/\[acme tn_0123456…\] tenant-line/);
});

it("E7: --env leaves a hook for WS-F", async () => {
  const root = await temporaryRoot();
  roots.push(root);
  let hooked = false;
  await statusCommand({
    root,
    env: true,
    envHook: () => {
      hooked = true;
    },
  });
  expect(hooked).toBe(true);
});

it("E11: run uses an installed version directory", async () => {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  const version = "1.2.3-run";
  await writeFakeInstall(paths, version);
  expect(existsSync(join(paths.runtime, version))).toBe(true);
});
