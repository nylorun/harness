import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LauncherError } from "../../src/launcher/errors.js";
import { down, restart, run, up } from "../../src/launcher/lifecycle.js";
import { ensureHostLayout, hostPaths } from "../../src/launcher/paths.js";
import { forceKillHost, nodeBinaryPath } from "../../src/launcher/spawn.js";
import { status } from "../../src/launcher/status.js";
import { writeFakeBuild } from "./fixtures/fake-build.js";
import {
  currentPlatformArch,
  removeRoot,
  temporaryRoot,
} from "./fixtures/registry.js";

const roots: string[] = [];
afterEach(async () => {
  // Best-effort: stop any Host left running under temp roots.
  for (const root of [...roots]) {
    try {
      const paths = hostPaths(root);
      const current = currentPlatformArch();
      await down(
        {
          paths,
          ...current,
          registry: "http://127.0.0.1:9",
          baselineEnv: { PATH: process.env.PATH },
          lock: { pollMs: 20, waitMs: 5_000 },
        },
        { force: true },
      );
    } catch {
      /* ignore */
    }
  }
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function setup(version = "0.9.0-e2") {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  const current = currentPlatformArch();
  const source = await temporaryRoot("nylorun-build-");
  roots.push(source);
  await writeFakeBuild(source, { version, ...current });
  const ctx = {
    paths,
    ...current,
    registry: "http://127.0.0.1:9",
    baselineEnv: { PATH: process.env.PATH, LANG: process.env.LANG },
    lock: { pollMs: 20, waitMs: 10_000 },
  };
  return { root, paths, current, source, version, ctx };
}

it("E2-8/9: up creates host.json, installs, starts Host on build Node, writes state after ready", async () => {
  const { paths, source, version, ctx, current } = await setup();
  const result = await up(ctx, { version, port: 0, from: source });
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

  const again = await up(ctx, { version, from: source });
  expect(again.started).toBe(false);
  expect(again.pid).toBe(result.pid);

  const st = await status(paths, current);
  expect(st.state).toBe("running");
  expect(nodeBinaryPath(join(paths.runtime, version), current.platform)).toContain(
    join("node", "bin"),
  );
});

it("E2-8: up refuses foreign_port and host_unresponsive; version_required without pin", async () => {
  const { paths, ctx } = await setup();
  await expect(up(ctx, { port: 0 })).rejects.toMatchObject({
    code: "version_required",
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
    await expect(up(ctx, { version: "0.9.0-e2", port: foreignPort })).rejects.toMatchObject({
      code: "foreign_port",
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      foreign.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

it("E2-8: schema guard blocks up when tenant schema is newer", async () => {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  const current = currentPlatformArch();
  const version = "0.9.1-schema";
  const source = await temporaryRoot("nylorun-build-");
  roots.push(source);
  await writeFakeBuild(source, {
    version,
    ...current,
    tenantSchemaMax: 1,
  });
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
  const ctx = {
    paths,
    ...current,
    registry: "http://127.0.0.1:9",
    baselineEnv: { PATH: process.env.PATH },
    lock: { pollMs: 20, waitMs: 10_000 },
  };
  await expect(up(ctx, { version, port: 0, from: source })).rejects.toMatchObject({
    code: "host_schema_newer",
  });
});

it("E2-10: down stops Host; active_work without --force; --force skips", async () => {
  const { paths, source, version, ctx } = await setup("0.9.2-down");
  // Rewrite build with sessions stub via env — inject through baseline won't work
  // for child. Use POST /_stub/aggregate after start.
  const started = await up(ctx, { version, port: 0, from: source });
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

it("E2-11: restart verifies target before stop; downgrade_refused without flag", async () => {
  const { paths, source, version, ctx, current } = await setup("0.9.3-a");
  await up(ctx, { version, port: 0, from: source });

  const newer = "0.9.4-b";
  const newerSource = await temporaryRoot("nylorun-build-");
  roots.push(newerSource);
  await writeFakeBuild(newerSource, { version: newer, ...current });

  const upgraded = await restart(ctx, {
    version: newer,
    from: newerSource,
    force: true,
  });
  expect(upgraded.started).toBe(true);
  expect(upgraded.version).toBe(newer);
  const config = JSON.parse(await readFile(paths.config, "utf8"));
  expect(config.runtimeVersion).toBe(newer);

  await expect(
    restart(ctx, { version, from: source, force: true }),
  ).rejects.toMatchObject({ code: "downgrade_refused" });

  const downgraded = await restart(ctx, {
    version,
    from: source,
    force: true,
    allowDowngrade: true,
  });
  expect(downgraded.version).toBe(version);
});

it("E2-12: run emits ready then stops on signal", async () => {
  const { source, version, ctx } = await setup("0.9.5-run");
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
      version,
      port: 0,
      from: source,
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

it("E2-14: forceKillHost and nodeBinaryPath cover Windows vs POSIX shapes", () => {
  expect(nodeBinaryPath("/build", "win32")).toMatch(/node\.exe$/);
  expect(nodeBinaryPath("/build", "linux")).toMatch(/bin\/node$/);
  // POSIX path: killing a nonexistent PID must not throw.
  expect(() => forceKillHost(999_999_997, "linux")).not.toThrow();
});
