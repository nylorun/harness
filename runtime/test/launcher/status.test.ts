import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureHostLayout, hostPaths } from "../../src/launcher/paths.js";
import { status } from "../../src/launcher/status.js";
import { writeFakeBuild } from "./fixtures/fake-build.js";
import {
  currentPlatformArch,
  removeRoot,
  temporaryRoot,
} from "./fixtures/registry.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    ),
  );
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function home() {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  return paths;
}

async function listen(
  handler: Parameters<typeof createServer>[0],
): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  servers.push(server);
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") reject(new Error("bind"));
      else resolve(address.port);
    });
  });
  return { server, port };
}

it("E1-5: status reports absent without host.json and lists installed builds", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  await writeFakeBuild(join(paths.runtime, "0.9.0-beta"), {
    version: "0.9.0-beta",
    ...current,
  });
  const result = await status(paths, current);
  expect(result.state).toBe("absent");
  expect(result.launcherProtocol).toBe(1);
  expect(result.home).toBe(paths.root);
  expect(result.installed).toEqual(["0.9.0-beta"]);
});

it("E1-5: status reports running when /health matches hostId", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  const hostId = "host_0123456789abcdefghjkmnpq";
  const { port } = await listen((req, res) => {
    if (new URL(req.url ?? "/", "http://127.0.0.1").pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          service: "nylorun-runtime",
          version: "0.9.0-beta",
          hostId,
          pid: process.pid,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await writeFile(
    paths.config,
    JSON.stringify({
      format: 1,
      hostId,
      host: "127.0.0.1",
      port,
      runtimeVersion: "0.9.0-beta",
    }),
  );
  const result = await status(paths, current);
  expect(result.state).toBe("running");
  expect(result.hostId).toBe(hostId);
  expect(result.pid).toBe(process.pid);
  expect(result.runtimeVersion).toBe("0.9.0-beta");
});

it("E1-5: status reports unresponsive when PID is alive but /health is silent", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  const free = await listen(() => undefined);
  const freePort = free.port;
  // Stop listening so health fails, but keep the port number.
  await new Promise<void>((resolve, reject) =>
    free.server.close((error) => (error ? reject(error) : resolve())),
  );
  servers.splice(servers.indexOf(free.server), 1);

  await writeFile(
    paths.config,
    JSON.stringify({
      format: 1,
      hostId: "host_0123456789abcdefghjkmnpq",
      host: "127.0.0.1",
      port: freePort,
      runtimeVersion: "0.9.0-beta",
    }),
  );
  await writeFile(
    paths.state,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.9.0-beta",
      entry: "x",
      url: `http://127.0.0.1:${freePort}`,
    }),
  );
  const result = await status(paths, current);
  expect(result.state).toBe("unresponsive");
  expect(result.pid).toBe(process.pid);
});

it("E1-5: status reports stopped and foreign-port", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  const free = await listen(() => undefined);
  const freePort = free.port;
  await new Promise<void>((resolve, reject) =>
    free.server.close((error) => (error ? reject(error) : resolve())),
  );
  servers.splice(servers.indexOf(free.server), 1);

  await writeFile(
    paths.config,
    JSON.stringify({
      format: 1,
      hostId: "host_0123456789abcdefghjkmnpq",
      host: "127.0.0.1",
      port: freePort,
    }),
  );
  await writeFile(
    paths.state,
    JSON.stringify({
      pid: 999_999_999,
      startedAt: new Date().toISOString(),
      version: "0.9.0-beta",
      entry: "x",
      url: `http://127.0.0.1:${freePort}`,
    }),
  );
  expect((await status(paths, current)).state).toBe("stopped");

  const { port: foreignPort } = await listen((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("nope");
  });
  await writeFile(
    paths.config,
    JSON.stringify({
      format: 1,
      hostId: "host_0123456789abcdefghjkmnpq",
      host: "127.0.0.1",
      port: foreignPort,
    }),
  );
  expect((await status(paths, current)).state).toBe("foreign-port");
});

it("E1-5: status takes no lock and does not mutate files", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  await writeFile(
    paths.config,
    JSON.stringify({
      format: 1,
      hostId: "host_0123456789abcdefghjkmnpq",
      host: "127.0.0.1",
      port: 59_999,
    }),
  );
  const marker = join(paths.root, "marker");
  await writeFile(marker, "before");
  await status(paths, current);
  const { readFile, access } = await import("node:fs/promises");
  expect(await readFile(marker, "utf8")).toBe("before");
  await expect(access(paths.lifecycleLock)).rejects.toThrow();
});
