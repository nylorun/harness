import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LauncherError } from "../../src/launcher/errors.js";
import {
  down,
  restart,
  run,
  up,
  type LifecycleContext,
} from "../../src/launcher/lifecycle.js";
import { ensureHostLayout, hostPaths } from "../../src/launcher/paths.js";
import { forceKillHost } from "../../src/launcher/spawn.js";
import { status } from "../../src/launcher/status.js";
import { writeFakeHost } from "./fixtures/fake-host.js";
import { removeRoot, temporaryRoot } from "./fixtures/roots.js";

const roots: string[] = [];
const contexts: LifecycleContext[] = [];
afterEach(async () => {
  // Best-effort: stop any Host left running under temp roots.
  for (const ctx of contexts.splice(0)) {
    try {
      await down(ctx, { force: true });
    } catch {
      /* ignore */
    }
  }
  // Give Windows a beat to release node.exe file locks before rmdir.
  if (process.platform === "win32" && roots.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await Promise.all(roots.splice(0).map(removeRoot));
});

/** A launcher context whose installed Runtime is `version` (fake Host stub). */
async function installed(
  paths: ReturnType<typeof hostPaths>,
  version: string,
  tenantSchemaMax = 1,
): Promise<LifecycleContext> {
  const dir = await temporaryRoot("nylorun-host-");
  roots.push(dir);
  const ctx: LifecycleContext = {
    paths,
    platform: process.platform,
    nodeBinary: process.execPath,
    hostEntry: await writeFakeHost(dir, { version }),
    runtimeVersion: version,
    tenantSchemaMax,
    baselineEnv: { PATH: process.env.PATH, LANG: process.env.LANG },
    lock: { pollMs: 20, waitMs: 10_000 },
  };
  contexts.push(ctx);
  return ctx;
}

async function setup(version = "0.9.0-e2") {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  return { root, paths, version, ctx: await installed(paths, version) };
}

it("E2-8/9: up creates host.json, starts the Host on the launcher's Node, writes state after ready", async () => {
  const { paths, version, ctx } = await setup();
  const result = await up(ctx, { port: 0 });
  expect(result.started).toBe(true);
  expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(result.pid).toBeGreaterThan(0);
  expect(result.version).toBe(version);
  expect(existsSync(paths.state)).toBe(true);
  expect(existsSync(paths.credentials)).toBe(true);
  const config = JSON.parse(await readFile(paths.config, "utf8"));
  expect(config.format).toBe(1);
  expect(config.runtimeVersion).toBe(version);
  expect(config.port).not.toBe(8787); // port 0 → free port

  const again = await up(ctx);
  expect(again.started).toBe(false);
  expect(again.pid).toBe(result.pid);

  const st = await status(paths, version);
  expect(st.state).toBe("running");
  expect(st.launcherVersion).toBe(version);
});

it("E2-8: up refuses foreign_port and a missing Host entry", async () => {
  const { ctx } = await setup();
  await expect(
    up({ ...ctx, hostEntry: join(ctx.paths.root, "missing.js") }, { port: 0 }),
  ).rejects.toMatchObject({
    code: "host_start_failed",
  } satisfies Partial<LauncherError>);

  // Foreign listener on an explicit port
  const { createServer } = await import("node:http");
  const foreign = createServer((_req, res) => {
    res.writeHead(200);
    res.end("x");
  });
  const foreignPort = await new Promise<number>((resolve, reject) => {
    foreign.listen(0, "127.0.0.1", () => {
      const address = foreign.address();
      if (!address || typeof address === "string") reject(new Error("bind"));
      else resolve(address.port);
    });
  });
  try {
    await expect(up(ctx, { port: foreignPort })).rejects.toMatchObject({
      code: "foreign_port",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      foreign.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

it("E2-8: schema guard blocks up when tenant schema is newer", async () => {
  const { paths, ctx } = await setup("0.9.1-schema");
  const tenantId = "tn_0123456789abcdefghjkmnpq";
  await mkdir(join(paths.tenants, tenantId), { recursive: true });
  await writeFile(
    join(paths.tenants, tenantId, "tenant.json"),
    JSON.stringify({
      id: tenantId,
      name: "t",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      schemaVersion: 99,
    }),
  );
  await expect(up(ctx, { port: 0 })).rejects.toMatchObject({
    code: "host_schema_newer",
  });
});

it("E2-10: down stops Host; active_work without --force; --force skips", async () => {
  const { paths, ctx } = await setup("0.9.2-down");
  const started = await up(ctx, { port: 0 });
  await fetch(`${started.url}/_stub/aggregate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ runningSessions: 2, connectedExecutors: 1 }),
  });
  await expect(down(ctx)).rejects.toMatchObject({ code: "active_work" });

  const forced = await down(ctx, { force: true });
  expect(forced.stopped).toBe(true);
  expect(existsSync(paths.state)).toBe(false);
  expect(existsSync(paths.config)).toBe(true);

  const noop = await down(ctx, { force: true });
  expect(noop.stopped).toBe(false);
});

it("E2-11: restart moves the Host onto the installed Runtime; downgrade_refused without flag", async () => {
  const { paths, version, ctx } = await setup("0.9.3-a");
  await up(ctx, { port: 0 });

  // `npm install --global @nylorun/runtime@0.9.4-b`, then restart.
  const newer = await installed(paths, "0.9.4-b");
  const upgraded = await restart(newer, { force: true });
  expect(upgraded.started).toBe(true);
  expect(upgraded.version).toBe("0.9.4-b");
  const config = JSON.parse(await readFile(paths.config, "utf8"));
  expect(config.runtimeVersion).toBe("0.9.4-b");

  // Reinstalling the older Runtime must not silently take over the Host root.
  await expect(restart(ctx, { force: true })).rejects.toMatchObject({
    code: "downgrade_refused",
  });
  await down(newer, { force: true });
  await expect(up(ctx, { port: 0 })).rejects.toMatchObject({
    code: "downgrade_refused",
  });

  const downgraded = await restart(ctx, { force: true, allowDowngrade: true });
  expect(downgraded.version).toBe(version);
});

it("E2-12: run emits ready then stops on signal", async () => {
  const { version, ctx } = await setup("0.9.5-run");
  let signalHandler: ((s: NodeJS.Signals) => void) | undefined;
  const ready: unknown[] = [];
  const finished = run(
    {
      ...ctx,
      onSignal: (handler) => {
        signalHandler = handler;
        return () => {
          signalHandler = undefined;
        };
      },
    },
    {
      port: 0,
      onReady: (r) => ready.push(r),
    },
  );
  // Wait until ready
  const deadline = Date.now() + 10_000;
  while (ready.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(ready).toHaveLength(1);
  expect((ready[0] as { started: boolean }).started).toBe(true);
  signalHandler?.("SIGTERM");
  const result = await finished;
  expect(result.version).toBe(version);
});

it("E2-14: forceKillHost tolerates a missing PID", () => {
  // POSIX path: killing a nonexistent PID must not throw.
  expect(() => forceKillHost(999_999_997, "linux")).not.toThrow();
});
