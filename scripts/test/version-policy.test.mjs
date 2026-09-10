import assert from "node:assert/strict";
import { test } from "node:test";
import { planVersions } from "../release/version-policy.mjs";

const versions = {
  harness: "0.10.0-beta.1",
  runtime: "0.1.0-beta.1",
  studio: "0.3.0-beta.1",
  "create-agent": "0.1.0-beta.1",
};
const pins = {
  harness: versions.harness,
  runtime: versions.runtime,
  studio: versions.studio,
};
const intent = (name, type = "patch") => ({
  id: `change-${name}`,
  summary: "Change behavior.",
  releases: [{ name: `@nylorun/${name}`, type }],
});

test("the migration computes the approved four-package targets and exact pins", () => {
  const { plan, releases } = planVersions(
    versions,
    pins,
    [
      intent("harness", "minor"),
      intent("runtime"),
      intent("studio", "minor"),
      intent("create-agent", "minor"),
    ],
    "beta"
  );
  assert.deepEqual(plan.packages, {
    harness: "0.11.0-beta",
    runtime: "0.1.1-beta",
    studio: "0.4.0-beta",
    "create-agent": "0.2.0-beta",
  });
  for (const name of ["harness", "runtime", "studio"])
    assert.equal(plan.compatibility[name], plan.packages[name]);
  for (const release of releases)
    assert.equal(release.newVersion, plan.packages[release.name.slice(9)]);
});

for (const [before, type, expected] of [
  ["0.11.0-beta", "patch", "0.11.1-beta"],
  ["0.11.0-beta", "minor", "0.12.0-beta"],
  ["0.11.0-beta", "major", "0.12.0-beta"],
  ["1.2.3-beta", "major", "2.0.0-beta"],
  ["0.11.0", "patch", "0.11.1-beta"],
  ["0.11.0-beta.8", "patch", "0.11.1-beta"],
])
  test(`${before} with ${type} intent becomes ${expected}`, () => {
    assert.equal(
      planVersions(
        { ...versions, harness: before },
        pins,
        [intent("harness", type)],
        "beta"
      ).plan.packages.harness,
      expected
    );
  });

test("stable promotion preserves numeric cores without pending intent", () => {
  const { plan } = planVersions(versions, pins, [], "latest");
  assert.deepEqual(plan.packages, {
    harness: "0.10.0",
    runtime: "0.1.0",
    studio: "0.3.0",
    "create-agent": "0.1.0",
  });
});

test("pending stable changes bump the core instead of simply stripping beta", () => {
  const { plan } = planVersions(
    { ...versions, runtime: "0.1.1-beta" },
    pins,
    [intent("runtime")],
    "latest"
  );
  assert.equal(plan.packages.runtime, "0.1.2");
  assert.equal(plan.compatibility.runtime, "0.1.2");
});

test("a stable creator is patched when another package is promoted", () => {
  const before = {
    harness: "1.0.0",
    runtime: "1.1.0-beta",
    studio: "1.0.0",
    "create-agent": "1.0.0",
  };
  assert.deepEqual(
    planVersions(
      before,
      { harness: "1.0.0", runtime: "1.1.0-beta", studio: "1.0.0" },
      [],
      "latest"
    ).plan.packages,
    { runtime: "1.1.0", "create-agent": "1.0.1" }
  );
});

test("creator-only releases retain the exact compatibility combination", () => {
  const { plan } = planVersions(
    versions,
    pins,
    [intent("create-agent")],
    "beta"
  );
  assert.deepEqual(plan.packages, { "create-agent": "0.1.1-beta" });
  assert.deepEqual(plan.compatibility, pins);
});

test("the strongest intent wins without double-counting changesets", () => {
  const changes = [
    intent("harness"),
    { ...intent("harness", "minor"), id: "feature" },
  ];
  assert.equal(
    planVersions(versions, pins, changes, "beta").plan.packages.harness,
    "0.11.0-beta"
  );
});

test("invalid inputs and empty release intent fail before applying a plan", () => {
  assert.throws(() => planVersions(versions, pins, [], "beta"), /No pending/);
  assert.throws(() => planVersions(versions, pins, [], "rc"), /Choose/);
  assert.throws(
    () => planVersions({ ...versions, runtime: "invalid" }, pins, [], "latest"),
    /Invalid current/
  );
  assert.throws(
    () => planVersions(versions, pins, [intent("unknown")], "beta"),
    /Unsupported/
  );
  assert.throws(
    () => planVersions(versions, pins, [intent("runtime", "invalid")], "beta"),
    /Unsupported/
  );
  const stable = Object.fromEntries(
    Object.keys(versions).map((name) => [name, "1.0.0"])
  );
  assert.throws(() => planVersions(stable, pins, [], "latest"), /No pending/);
});
