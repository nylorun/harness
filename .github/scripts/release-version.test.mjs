import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import {
  applyReleasePlan,
  calculateVersion,
  createReleasePlan,
  validatePublishPlan,
} from "./release-version.mjs";

const script = resolve(
  dirname(new URL(import.meta.url).pathname),
  "release-version.mjs",
);

const fixture = () => {
  const root = mkdtempSync(resolve(tmpdir(), "nylorun-release-version-"));
  mkdirSync(resolve(root, "harness"));
  mkdirSync(resolve(root, "studio"));
  writeFileSync(
    resolve(root, "harness/package.json"),
    JSON.stringify(
      { name: "@nylorun/harness", version: "0.10.0-beta.1" },
      null,
      2,
    ),
  );
  writeFileSync(
    resolve(root, "studio/package.json"),
    JSON.stringify({ name: "@nylorun/studio", version: "0.2.0-rc.4" }, null, 2),
  );
  writeFileSync(
    resolve(root, "package-lock.json"),
    JSON.stringify(
      {
        packages: {
          harness: { version: "0.10.0-beta.1" },
          studio: { version: "0.2.0-rc.4" },
        },
      },
      null,
      2,
    ),
  );
  return root;
};

const manifests = {
  harness: { version: "0.10.0-beta.1" },
  studio: { version: "0.2.0-rc.4" },
};

test("calculates beta base-version bumps for both packages", () => {
  assert.equal(
    calculateVersion({
      version: "0.10.0-beta.1",
      channel: "beta",
      action: "patch",
      prereleaseId: "beta",
    }),
    "0.10.1-beta.0",
  );
  assert.equal(
    calculateVersion({
      version: "0.2.0-rc.4",
      channel: "beta",
      action: "minor",
      prereleaseId: "rc",
    }),
    "0.3.0-rc.0",
  );
  assert.equal(
    calculateVersion({
      version: "0.2.0-rc.4",
      channel: "beta",
      action: "major",
      prereleaseId: "rc",
    }),
    "1.0.0-rc.0",
  );
});

test("promotes prereleases to stable versions", () => {
  assert.equal(
    calculateVersion({
      version: "0.10.0-beta.1",
      channel: "stable",
      action: "promote",
      prereleaseId: "beta",
    }),
    "0.10.0",
  );
  assert.equal(
    calculateVersion({
      version: "0.2.0-rc.4",
      channel: "stable",
      action: "promote",
      prereleaseId: "rc",
    }),
    "0.2.0",
  );
});

test("rejects invalid beta and stable release actions", () => {
  assert.throws(
    () =>
      calculateVersion({
        version: "0.10.0-beta.1",
        channel: "beta",
        action: "promote",
        prereleaseId: "beta",
      }),
    /Beta releases require/,
  );
  assert.throws(
    () =>
      calculateVersion({
        version: "0.10.0-beta.1",
        channel: "stable",
        action: "patch",
        prereleaseId: "beta",
      }),
    /Stable releases require/,
  );
  assert.throws(
    () =>
      calculateVersion({
        version: "0.10.0",
        channel: "stable",
        action: "promote",
        prereleaseId: "beta",
      }),
    /requires a beta or RC/,
  );
});

test("creates a scope-aware release plan and updates only selected manifests", () => {
  const root = fixture();
  try {
    const plan = createReleasePlan({
      manifests,
      scope: "harness",
      channel: "beta",
      action: "patch",
    });
    assert.deepEqual(
      plan.map(({ key, version }) => ({ key, version })),
      [{ key: "harness", version: "0.10.1-beta.0" }],
    );
    applyReleasePlan({ root, plan });
    assert.equal(
      JSON.parse(readFileSync(resolve(root, "harness/package.json"), "utf8"))
        .version,
      "0.10.1-beta.0",
    );
    assert.equal(
      JSON.parse(readFileSync(resolve(root, "studio/package.json"), "utf8"))
        .version,
      "0.2.0-rc.4",
    );
    assert.equal(
      JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"))
        .packages.harness.version,
      "0.10.1-beta.0",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the default CLI mode is dry and leaves manifests unchanged", () => {
  const root = fixture();
  try {
    const before = readFileSync(resolve(root, "harness/package.json"), "utf8");
    const output = execFileSync(
      process.execPath,
      [
        script,
        "--root",
        root,
        "--scope",
        "harness",
        "--channel",
        "beta",
        "--action",
        "patch",
      ],
      { encoding: "utf8" },
    );
    assert.equal(JSON.parse(output).plan[0].version, "0.10.1-beta.0");
    assert.equal(
      readFileSync(resolve(root, "harness/package.json"), "utf8"),
      before,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("validates publish metadata and package-specific tags", () => {
  assert.deepEqual(
    validatePublishPlan({ manifests, scope: "both" }).map(
      ({ key, distTag, tagPrefix, version }) => ({
        key,
        distTag,
        tag: tagPrefix + version,
      }),
    ),
    [
      { key: "harness", distTag: "beta", tag: "v0.10.0-beta.1" },
      { key: "studio", distTag: "beta", tag: "studio-v0.2.0-rc.4" },
    ],
  );
  assert.throws(
    () =>
      validatePublishPlan({
        manifests: { ...manifests, studio: { version: "0.2.0-beta.1" } },
        scope: "studio",
      }),
    /must use rc.N/,
  );
});
