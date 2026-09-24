import { createServer } from "node:net";
import { readFile, stat } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { CliError } from "../../src/errors.js";
import {
  credentialsMode,
  ensureHostConfig,
  ensureHostCredentials,
  hostPaths,
  isHostId,
  newHostId,
  resolveHostRoot,
} from "../../src/host/root.js";
import {
  removeRoot,
  startForeignListener,
  temporaryRoot,
} from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function root() {
  const value = await temporaryRoot();
  roots.push(value);
  return value;
}

it("E2: Host root is NYLORUN_HOME or ~/.nylorun, resolved absolute", () => {
  expect(resolveHostRoot({ NYLORUN_HOME: "/tmp/custom-home" })).toBe(
    "/tmp/custom-home",
  );
  expect(resolveHostRoot({ HOME: "/tmp/user", NYLORUN_HOME: "" })).toMatch(
    /\/\.nylorun$/,
  );
});

it("E2: host.json is created on first setup with hostId and port 8787 when free", async () => {
  const paths = hostPaths(await root());
  const { config, created, portSelected } = await ensureHostConfig(paths);
  expect(created).toBe(true);
  expect(portSelected).toBe(false);
  expect(isHostId(config.hostId)).toBe(true);
  expect(config.port).toBe(8787);
  expect(config.host).toBe("127.0.0.1");
  const onDisk = JSON.parse(await readFile(paths.config, "utf8"));
  expect(onDisk.hostId).toBe(config.hostId);
});

it("E2: when default port is foreign on first setup, a free port is persisted", async () => {
  const binder = createServer();
  binder.on("connection", (socket) => socket.destroy());
  const bound8787 = await new Promise<boolean>((resolve) => {
    binder.once("error", () => resolve(false));
    binder.listen(8787, "127.0.0.1", () => resolve(true));
  });
  try {
    if (!bound8787) {
      // 8787 already taken — still assert explicit foreign port fails strictly.
      const foreign = await startForeignListener();
      try {
        const paths = hostPaths(await root());
        await expect(
          ensureHostConfig(paths, { port: foreign.port }),
        ).rejects.toBeInstanceOf(CliError);
      } finally {
        await foreign.close();
      }
      return;
    }
    const paths = hostPaths(await root());
    const { config, portSelected } = await ensureHostConfig(paths);
    expect(portSelected).toBe(true);
    expect(config.port).not.toBe(8787);
    expect(config.port).toBeGreaterThan(0);
  } finally {
    if (bound8787) {
      await new Promise<void>((resolve) => binder.close(() => resolve()));
    }
  }
});

it("E2: explicit --port is strict on collision", async () => {
  const foreign = await startForeignListener();
  try {
    const paths = hostPaths(await root());
    await expect(
      ensureHostConfig(paths, { port: foreign.port }),
    ).rejects.toMatchObject({ exitCode: 4 });
  } finally {
    await foreign.close();
  }
});

it("E3: host-credentials.json is created 0600 with a 64-hex admin key", async () => {
  const paths = hostPaths(await root());
  await ensureHostConfig(paths);
  const credentials = await ensureHostCredentials(paths);
  expect(credentials.adminKey).toMatch(/^[0-9a-f]{64}$/);
  const mode = credentialsMode(paths);
  if (process.platform !== "win32") {
    expect(mode).toBe(0o600);
  }
  const again = await ensureHostCredentials(paths);
  expect(again.adminKey).toBe(credentials.adminKey);
  const st = await stat(paths.credentials);
  expect(st.isFile()).toBe(true);
});

it("newHostId matches the host_ + 26 Crockford pattern", () => {
  const id = newHostId();
  expect(isHostId(id)).toBe(true);
  expect(id).not.toBe(newHostId());
});
