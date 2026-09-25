import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bootstrap } from "../../src/runtime/bootstrap.js";
import { newestBuild } from "../../src/runtime/builds.js";
import {
  currentPlatformArch,
  removeRoot,
  startRegistryWithCliBuild,
  temporaryRoot,
  writeCliTestBuild,
} from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

describe("F1-2 bootstrap", () => {
  it("downloads, verifies, installs via extracted launcher, and removes .download-*", async () => {
    const version = "0.9.0-f1-boot";
    const home = await temporaryRoot("nylorun-cli-home-");
    roots.push(home);
    const registry = await startRegistryWithCliBuild(version);
    roots.push(...registry.roots.filter((r) => r !== registry.buildDir));

    const progress: string[] = [];
    const result = await bootstrap(home, version, {
      registry: registry.url,
      onProgress: (event) => progress.push(event.phase),
      env: { ...process.env, NYLORUN_REGISTRY: registry.url },
    });

    expect(result.version).toBe(version);
    expect(existsSync(result.path)).toBe(true);
    expect(newestBuild(home)?.version).toBe(version);

    const runtimeDir = join(home, "runtime");
    const names = readdirSync(runtimeDir);
    expect(names.some((n) => n.startsWith(".download-"))).toBe(false);
    expect(progress).toContain("download");
    expect(progress).toContain("verify");
    expect(progress).toContain("extract");
    expect(progress).toContain("install");

    await registry.close();
  });

  it("leaves nothing outside .download-* on integrity failure, then removes staging", async () => {
    const version = "0.9.0-f1-bad";
    const home = await temporaryRoot("nylorun-cli-home-");
    roots.push(home);
    const buildDir = await temporaryRoot("nylorun-cli-build-");
    roots.push(buildDir);
    await writeCliTestBuild(buildDir, {
      version,
      ...currentPlatformArch(),
    });
    const { startFakeRegistry } = await import("./support.js");
    const registry = await startFakeRegistry({
      version,
      buildDir,
      integrityOverride: "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
    });

    await expect(
      bootstrap(home, version, {
        registry: registry.url,
        onProgress: () => undefined,
        env: { ...process.env, NYLORUN_REGISTRY: registry.url },
      }),
    ).rejects.toThrow(/integrity/i);

    const runtimeDir = join(home, "runtime");
    if (existsSync(runtimeDir)) {
      const names = readdirSync(runtimeDir);
      expect(names.some((n) => n.startsWith(".download-"))).toBe(false);
      expect(names.filter((n) => !n.startsWith("."))).toEqual([]);
    }

    await registry.close();
  });

  it("rejects Intel macOS before downloading (no darwin-x64 build is published)", async () => {
    const home = await temporaryRoot("nylorun-cli-home-");
    roots.push(home);

    await expect(
      bootstrap(home, "0.9.0-f1-intel", {
        registry: "http://127.0.0.1:9",
        platform: { platform: "darwin", arch: "x64" },
        onProgress: () => undefined,
      }),
    ).rejects.toThrow(/Intel macOS/);
    expect(existsSync(join(home, "runtime"))).toBe(false);
  });
});
