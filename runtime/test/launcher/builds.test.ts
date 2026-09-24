import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { newestBuild } from "../../src/launcher/builds.js";
import { ensureHostLayout, hostPaths } from "../../src/launcher/paths.js";
import {
  writeFakeBuild,
  writeTenantsEraInstall,
} from "./fixtures/fake-build.js";
import {
  currentPlatformArch,
  removeRoot,
  temporaryRoot,
} from "./fixtures/registry.js";

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

it('E1-1: newestBuild skips dot-directories, Tenants-era installs, and other platforms', async () => {
  const paths = await home();
  const { platform, arch } = currentPlatformArch();
  const otherPlatform = platform === "linux" ? "darwin" : "linux";

  await writeFakeBuild(join(paths.runtime, "0.8.0-beta"), {
    version: "0.8.0-beta",
    platform,
    arch,
  });
  await writeFakeBuild(join(paths.runtime, "0.9.0-beta"), {
    version: "0.9.0-beta",
    platform,
    arch,
  });
  await writeFakeBuild(join(paths.runtime, "1.0.0-beta"), {
    version: "1.0.0-beta",
    platform: otherPlatform,
    arch,
  });
  await writeTenantsEraInstall(join(paths.runtime, "0.7.0-beta"), "0.7.0-beta");
  await mkdir(join(paths.runtime, ".download-abc"), { recursive: true });
  await writeFile(join(paths.runtime, ".download-abc", "x"), "x");

  const newest = newestBuild(paths, { platform, arch });
  expect(newest?.version).toBe("0.9.0-beta");
  expect(newest?.path).toBe(join(paths.runtime, "0.9.0-beta"));
});

it("E1-1: newestBuild orders by SemVer including prereleases", async () => {
  const paths = await home();
  const current = currentPlatformArch();
  await writeFakeBuild(join(paths.runtime, "0.9.0"), {
    version: "0.9.0",
    ...current,
  });
  await writeFakeBuild(join(paths.runtime, "0.9.0-beta"), {
    version: "0.9.0-beta",
    ...current,
  });
  const newest = newestBuild(paths, current);
  expect(newest?.version).toBe("0.9.0");
});
