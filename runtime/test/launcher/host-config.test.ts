import { readFile, writeFile } from "node:fs/promises";
import { afterEach, expect, it } from "vitest";
import { LauncherError } from "../../src/launcher/errors.js";
import {
  hostConfigFormat,
  newHostId,
  readHostConfig,
  writeHostConfig,
} from "../../src/launcher/host-config.js";
import { ensureHostLayout, hostPaths } from "../../src/launcher/paths.js";
import { removeRoot, temporaryRoot } from "./fixtures/registry.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function home() {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  return paths;
}

it("E1-2: format 0 host.json upgrades to format 1 on write and keeps unknown fields", async () => {
  const paths = await home();
  await writeFile(
    paths.config,
    JSON.stringify({
      hostId: "host_0123456789abcdefghjkmnpq",
      host: "127.0.0.1",
      port: 8787,
      customField: "keep-me",
    }),
  );
  const existing = await readHostConfig(paths);
  expect(existing).toBeDefined();
  expect(hostConfigFormat(existing!)).toBe(0);

  await writeHostConfig(paths, {
    format: 1,
    hostId: existing!.hostId,
    host: existing!.host,
    port: existing!.port,
    runtimeVersion: "0.9.0-beta",
  });

  const onDisk = JSON.parse(await readFile(paths.config, "utf8")) as Record<
    string,
    unknown
  >;
  expect(onDisk.format).toBe(1);
  expect(onDisk.customField).toBe("keep-me");
  expect(onDisk.runtimeVersion).toBe("0.9.0-beta");
});

it("E1-2: writing refuses host_format_newer", async () => {
  const paths = await home();
  await writeFile(
    paths.config,
    JSON.stringify({
      format: 2,
      hostId: "host_0123456789abcdefghjkmnpq",
      host: "127.0.0.1",
      port: 8787,
    }),
  );
  await expect(
    writeHostConfig(paths, {
      format: 1,
      hostId: newHostId(),
      host: "127.0.0.1",
      port: 8787,
    }),
  ).rejects.toMatchObject({ code: "host_format_newer" } satisfies Partial<LauncherError>);
});
