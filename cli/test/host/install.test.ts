import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { CliError } from "../../src/errors.js";
import {
  ensureInstalled,
  verifyInstalled,
  writeFakeInstall,
} from "../../src/host/install.js";
import { ensureHostLayout, hostPaths } from "../../src/host/root.js";
import { removeRoot, temporaryRoot } from "./support.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(removeRoot));
});

async function paths() {
  const root = await temporaryRoot();
  roots.push(root);
  const value = hostPaths(root);
  await ensureHostLayout(value);
  return value;
}

it("E4: reuses a verified runtime/<version>/ install", async () => {
  const host = await paths();
  const version = "9.9.9-test";
  await writeFakeInstall(host, version);
  let installs = 0;
  const result = await ensureInstalled(host, {
    version,
    installer: async () => {
      installs += 1;
    },
  });
  expect(installs).toBe(0);
  expect(result.version).toBe(version);
  expect(existsSync(result.entry)).toBe(true);
});

it("E4: installs via injectable installer into staging then atomic rename", async () => {
  const host = await paths();
  const version = "9.9.8-test";
  let stagingSeen = "";
  const result = await ensureInstalled(host, {
    version,
    installer: async ({ stagingDir, version: v }) => {
      stagingSeen = stagingDir;
      expect(stagingDir).toContain(`.tmp-${v}-`);
      await writeFakeInstall(
        { ...host, runtime: stagingDir, root: stagingDir },
        v,
      );
      // writeFakeInstall nests under runtime/<version>; flatten for staging layout.
      // For staging, installer should put node_modules at staging root.
      const nested = join(stagingDir, v);
      if (existsSync(nested)) {
        const { rename, rm } = await import("node:fs/promises");
        // Move contents of staging/<version>/* up — simpler: write directly.
        await rm(nested, { recursive: true, force: true });
      }
      const pkgDir = join(stagingDir, "node_modules", "@nylorun", "runtime");
      await mkdir(join(pkgDir, "dist", "core"), { recursive: true });
      await writeFile(
        join(pkgDir, "dist", "core", "main.js"),
        "export {};\n",
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
    },
  });
  expect(stagingSeen).toContain(".tmp-");
  expect(existsSync(join(host.runtime, version))).toBe(true);
  expect(result.versionDir).toBe(join(host.runtime, version));
  expect(verifyInstalled(result.versionDir, version).version).toBe(version);
});

it("E4: concurrent callers wait and reuse a single install", async () => {
  const host = await paths();
  const version = "9.9.7-test";
  let installs = 0;
  const installer = async ({
    stagingDir,
    version: v,
  }: {
    stagingDir: string;
    version: string;
    versionDir: string;
  }) => {
    installs += 1;
    await new Promise((r) => setTimeout(r, 80));
    const pkgDir = join(stagingDir, "node_modules", "@nylorun", "runtime");
    await mkdir(join(pkgDir, "dist", "core"), { recursive: true });
    await writeFile(join(pkgDir, "dist", "core", "main.js"), "export {};\n");
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
  const [a, b] = await Promise.all([
    ensureInstalled(host, { version, installer, pollMs: 20 }),
    ensureInstalled(host, { version, installer, pollMs: 20 }),
  ]);
  expect(installs).toBe(1);
  expect(a.versionDir).toBe(b.versionDir);
});

it("E4: failed install leaves existing verified versions untouched", async () => {
  const host = await paths();
  const good = "9.9.6-test";
  await writeFakeInstall(host, good);
  const before = verifyInstalled(join(host.runtime, good), good);
  await expect(
    ensureInstalled(host, {
      version: "9.9.5-test",
      installer: async () => {
        throw new CliError("registry unavailable", 1);
      },
    }),
  ).rejects.toBeInstanceOf(CliError);
  expect(verifyInstalled(join(host.runtime, good), good).entry).toBe(
    before.entry,
  );
  expect(existsSync(join(host.runtime, "9.9.5-test"))).toBe(false);
});

it("E4: verify rejects install missing ./server export", async () => {
  const host = await paths();
  const version = "9.9.4-test";
  await writeFakeInstall(host, version, { withServerExport: false });
  expect(() => verifyInstalled(join(host.runtime, version), version)).toThrow(
    /does not export \.\/server/,
  );
});
