import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertCliRuntimePin,
  assertRuntimePins,
  syncCliRuntimePin,
} from "../release/pins.mjs";
import { readJson, writeJson } from "../lib/repo.mjs";

async function fixtureRepo({ runtimeVersion, cliRuntimePin }) {
  const root = await mkdtemp(join(tmpdir(), "nylorun-pins-"));
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "cli"), { recursive: true });
  const runtime = { name: "@nylorun/runtime", version: runtimeVersion };
  await writeJson(join(root, "runtime/package.json"), runtime);
  const cli = { name: "@nylorun/cli", version: "0.2.1-beta" };
  if (cliRuntimePin !== undefined) cli.nylorun = { runtime: cliRuntimePin };
  await writeJson(join(root, "cli/package.json"), cli);
  return root;
}

test("assertCliRuntimePin fails when nylorun.runtime differs from runtime version", async () => {
  const root = await fixtureRepo({
    runtimeVersion: "0.9.0-beta",
    cliRuntimePin: "0.8.0-beta",
  });
  try {
    await assert.rejects(
      () => assertCliRuntimePin(root),
      /nylorun\.runtime \(0\.8\.0-beta\) must equal runtime version \(0\.9\.0-beta\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertRuntimePins passes when the CLI pin matches", async () => {
  const root = await fixtureRepo({
    runtimeVersion: "0.9.0-beta",
    cliRuntimePin: "0.9.0-beta",
  });
  try {
    await assertRuntimePins(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("syncCliRuntimePin writes cli/package.json nylorun.runtime", async () => {
  const root = await fixtureRepo({
    runtimeVersion: "0.9.0-beta",
  });
  try {
    await syncCliRuntimePin(root, "0.9.1-beta");
    const cli = await readJson(join(root, "cli/package.json"));
    assert.equal(cli.nylorun.runtime, "0.9.1-beta");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
