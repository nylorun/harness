import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LauncherError } from "../../src/launcher/errors.js";
import { install, readInstallRecord } from "../../src/launcher/install.js";
import { ensureHostLayout, hostPaths } from "../../src/launcher/paths.js";
import {
  writeFakeBuild,
  writeTenantsEraInstall,
} from "./fixtures/fake-build.js";
import {
  currentPlatformArch,
  removeRoot,
  startFakeRegistry,
  temporaryRoot,
} from "./fixtures/registry.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function home() {
  const root = await temporaryRoot();
  roots.push(root);
  const paths = hostPaths(root);
  await ensureHostLayout(paths);
  return paths;
}

it("E1-4: install --from copies, verifies, writes install.json, and reuses", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  const version = "0.9.1-test";
  const source = await temporaryRoot("nylorun-build-");
  roots.push(source);
  await writeFakeBuild(source, { version, ...current });

  const first = await install(paths, {
    version,
    from: source,
    registry: "http://127.0.0.1:9",
    ...current,
  });
  expect(first.installed).toBe(true);
  expect(existsSync(join(first.path, "manifest.json"))).toBe(true);
  const record = await readInstallRecord(first.path);
  expect(record).toMatchObject({
    format: 1,
    version,
    source: "path",
    integrity: null,
  });

  const second = await install(paths, {
    version,
    from: source,
    registry: "http://127.0.0.1:9",
    ...current,
  });
  expect(second.installed).toBe(false);
  expect(second.path).toBe(first.path);
});

it("E1-4: install from registry verifies SRI, extracts, and replaces Tenants-era dir", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  const version = "0.9.2-test";
  const source = await temporaryRoot("nylorun-build-");
  roots.push(source);
  await writeFakeBuild(source, { version, ...current });
  const registry = await startFakeRegistry({ version, buildDir: source });
  closers.push(registry.close);

  await writeTenantsEraInstall(join(paths.runtime, version), version);
  expect(existsSync(join(paths.runtime, version, "manifest.json"))).toBe(false);

  const result = await install(paths, {
    version,
    registry: registry.url,
    ...current,
  });
  expect(result.installed).toBe(true);
  expect(existsSync(join(result.path, "manifest.json"))).toBe(true);
  const record = await readInstallRecord(result.path);
  expect(record?.source).toBe("registry");
  expect(record?.integrity).toBe(registry.integrity);
});

it("E1-4: integrity mismatch installs nothing", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  const version = "0.9.3-test";
  const source = await temporaryRoot("nylorun-build-");
  roots.push(source);
  await writeFakeBuild(source, { version, ...current });
  const registry = await startFakeRegistry({
    version,
    buildDir: source,
    integrityOverride: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  });
  closers.push(registry.close);

  await expect(
    install(paths, { version, registry: registry.url, ...current }),
  ).rejects.toMatchObject({ code: "integrity_mismatch" } satisfies Partial<LauncherError>);
  expect(existsSync(join(paths.runtime, version))).toBe(false);
});

it("E1-4: concurrent installs produce one result", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  const version = "0.9.4-test";
  const source = await temporaryRoot("nylorun-build-");
  roots.push(source);
  await writeFakeBuild(source, { version, ...current });
  const registry = await startFakeRegistry({ version, buildDir: source });
  closers.push(registry.close);

  const [a, b] = await Promise.all([
    install(paths, {
      version,
      registry: registry.url,
      ...current,
      lock: { pollMs: 20 },
    }),
    install(paths, {
      version,
      registry: registry.url,
      ...current,
      lock: { pollMs: 20 },
    }),
  ]);
  expect(a.path).toBe(b.path);
  expect([a.installed, b.installed].filter(Boolean).length).toBe(1);
});

it("E1-4: failed install leaves other versions untouched", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  const good = "0.9.5-test";
  await writeFakeBuild(join(paths.runtime, good), { version: good, ...current });
  await writeFile(
    join(paths.runtime, good, "install.json"),
    JSON.stringify({
      format: 1,
      version: good,
      integrity: null,
      source: "path",
      installedAt: new Date().toISOString(),
    }),
  );

  await expect(
    install(paths, {
      version: "0.9.6-missing",
      registry: "http://127.0.0.1:9",
      ...current,
    }),
  ).rejects.toBeInstanceOf(LauncherError);
  expect(existsSync(join(paths.runtime, good, "manifest.json"))).toBe(true);
  expect(existsSync(join(paths.runtime, "0.9.6-missing"))).toBe(false);
});

