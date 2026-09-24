import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildPackageName,
  currentPlatformArch,
  installNodeBinary,
  posixLauncherShim,
  windowsLauncherShim,
  writeBuildManifest,
  writeBuildShims,
} from "../lib/local-build.mjs";
import { readJson } from "../lib/repo.mjs";

test("currentPlatformArch accepts version-1 platforms and rejects others", () => {
  assert.deepEqual(currentPlatformArch("linux", "x64"), {
    platform: "linux",
    arch: "x64",
    key: "linux-x64",
  });
  assert.equal(buildPackageName("darwin", "arm64"), "@nylorun/runtime-darwin-arm64");
  assert.throws(
    () => currentPlatformArch("linux", "ia32"),
    /platform_unsupported/,
  );
});

test("build shims and manifest match D§8.2 layout pieces", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-local-build-"));
  try {
    const launcher = "lib/node_modules/@nylorun/runtime/dist/launcher/main.js";
    const { posixPath, cmdPath } = await writeBuildShims(root, launcher);
    const posix = await readFile(posixPath, "utf8");
    const cmd = await readFile(cmdPath, "utf8");
    assert.match(posix, /^#!\/bin\/sh/);
    assert.match(posix, /node\/bin\/node/);
    assert.match(posix, /launcher\/main\.js/);
    assert.equal(posix, posixLauncherShim(launcher));
    assert.match(cmd, /node\.exe/);
    assert.equal(cmd, windowsLauncherShim(launcher));

    await installNodeBinary(root, {
      sourcePath: process.execPath,
      windows: false,
    });
    await access(join(root, "node/bin/node"));

    const manifest = {
      format: 1,
      runtimeVersion: "0.9.0-beta",
      platform: "linux",
      arch: "x64",
      node: { version: process.versions.node },
      entry: "lib/node_modules/@nylorun/runtime/dist/host/main.js",
      launcher,
      launcherProtocol: 1,
      protocol: { min: 2, max: 2, features: ["runtime-tenants", "admin-status"] },
      tenantSchema: { max: 2 },
    };
    await writeBuildManifest(root, manifest);
    assert.deepEqual(await readJson(join(root, "manifest.json")), manifest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("localRuntimeBuild produces D§8.2 layout from the workspace", async (t) => {
  // Packing the real runtime is heavier than typical unit tests; skip when
  // dist is missing (developer machines mid-edit). CI and --local cover it.
  try {
    await access(join(process.cwd(), "runtime/dist/host/main.js"));
  } catch {
    t.skip("runtime/dist/host/main.js missing; run npm run build first");
    return;
  }

  const { localRuntimeBuild } = await import("../lib/local-build.mjs");
  const out = await mkdtemp(join(tmpdir(), "nylorun-runtime-build-out-"));
  try {
    const result = await localRuntimeBuild({ out });
    assert.equal(result.dir, out);
    assert.match(result.name, /^@nylorun\/runtime-/);
    assert.equal(typeof result.version, "string");

    const manifest = await readJson(join(out, "manifest.json"));
    assert.equal(manifest.format, 1);
    assert.equal(manifest.runtimeVersion, result.version);
    assert.equal(manifest.launcherProtocol, 1);
    assert.equal(manifest.node.version, process.versions.node);
    await access(join(out, "bin/nylorun-runtime"));
    await access(join(out, "bin/nylorun-runtime.cmd"));
    await access(join(out, "node/bin/node"));
    await access(
      join(out, "lib/node_modules/@nylorun/runtime/dist/host/main.js"),
    );
    await access(join(out, "package.json"));
    const pkg = await readJson(join(out, "package.json"));
    assert.equal(pkg.name, result.name);
    assert.equal(pkg.version, result.version);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
