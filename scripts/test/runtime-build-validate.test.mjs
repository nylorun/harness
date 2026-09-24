import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BUILD_SIZE_WARN_BYTES,
  buildPackageNames,
  runtimeBuildPublishOrder,
  validateBuildDirectory,
} from "../release/runtime-build-validate.mjs";
import { writeJson } from "../lib/repo.mjs";

test("runtimeBuildPublishOrder is the five D8 platforms", () => {
  assert.deepEqual(runtimeBuildPublishOrder(), [
    "@nylorun/runtime-darwin-arm64",
    "@nylorun/runtime-darwin-x64",
    "@nylorun/runtime-linux-x64",
    "@nylorun/runtime-linux-arm64",
    "@nylorun/runtime-win32-x64",
  ]);
  assert.equal(buildPackageNames().length, 5);
  assert.ok(BUILD_SIZE_WARN_BYTES === 60 * 1024 * 1024);
});

test("validateBuildDirectory accepts a minimal D§8.2 layout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nylorun-build-validate-"));
  try {
    await writeJson(join(dir, "package.json"), {
      name: "@nylorun/runtime-linux-x64",
      version: "0.9.0-beta",
      publishConfig: { access: "public", provenance: true },
    });
    await writeJson(join(dir, "manifest.json"), {
      format: 1,
      runtimeVersion: "0.9.0-beta",
      platform: "linux",
      arch: "x64",
      node: { version: "24.15.0" },
      entry: "lib/node_modules/@nylorun/runtime/dist/host/main.js",
      launcher: "lib/node_modules/@nylorun/runtime/dist/launcher/main.js",
      launcherProtocol: 1,
      protocol: { min: 2, max: 2, features: ["runtime-tenants"] },
      tenantSchema: { max: 1 },
    });
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin/nylorun-runtime"), "#!/bin/sh\n");
    const result = await validateBuildDirectory(dir);
    assert.equal(result.name, "@nylorun/runtime-linux-x64");
    assert.equal(result.version, "0.9.0-beta");
    assert.ok(result.size > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateBuildDirectory rejects missing provenance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nylorun-build-validate-"));
  try {
    await writeJson(join(dir, "package.json"), {
      name: "@nylorun/runtime-linux-x64",
      version: "0.9.0-beta",
    });
    await writeJson(join(dir, "manifest.json"), {
      format: 1,
      runtimeVersion: "0.9.0-beta",
      platform: "linux",
      arch: "x64",
      node: { version: "24.15.0" },
      entry: "e",
      launcher: "l",
      launcherProtocol: 1,
      protocol: { min: 2, max: 2, features: [] },
      tenantSchema: { max: 1 },
    });
    await assert.rejects(
      () => validateBuildDirectory(dir),
      /provenance/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
