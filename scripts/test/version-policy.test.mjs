import assert from "node:assert/strict";
import { test } from "node:test";
import { planVersions } from "../release/version-policy.mjs";

const versions = {
  core: "0.1.0-beta.1",
  cli: "0.1.0-beta.1",
  harness: "0.10.0-beta.1",
  agents: "0.1.0-beta.1",
  runtime: "0.1.0-beta.1",
  studio: "0.3.0-beta.1",
  "create-agent": "0.1.0-beta.1",
};
const pins = {
  core: versions.core,
  cli: versions.cli,
  harness: versions.harness,
  agents: versions.agents,
  runtime: versions.runtime,
  studio: versions.studio,
};
const intent = (name, type = "patch") => ({
  id: `change-${name}`,
  summary: "Change behavior.",
  releases: [{ name: `@nylorun/${name}`, type }],
});

test("the migration computes the approved package targets and exact pins", () => {
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
    cli: "0.1.1-beta",
    harness: "0.11.0-beta",
    runtime: "0.1.1-beta",
    studio: "0.4.0-beta",
    "create-agent": "0.2.0-beta",
  });
  for (const name of ["core", "harness", "agents", "runtime", "studio", "cli"])
    assert.equal(plan.compatibility[name], plan.packages[name] ?? versions[name]);
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

test("pre-1.0 latest promotion keeps *-beta versions for dist-tag moves", () => {
  const current = {
    core: "0.1.0-beta",
    cli: "0.1.0-beta",
    harness: "0.10.0-beta",
    agents: "0.1.0-beta",
    runtime: "0.1.0-beta",
    studio: "0.3.0-beta",
    "create-agent": "0.1.0-beta",
  };
  const { plan, releases } = planVersions(
    current,
    {
      core: current.core,
      cli: current.cli,
      harness: current.harness,
      agents: current.agents,
      runtime: current.runtime,
      studio: current.studio,
    },
    [],
    "latest"
  );
  assert.deepEqual(plan.packages, current);
  assert.equal(plan.channel, "latest");
  for (const release of releases)
    assert.equal(release.oldVersion, release.newVersion);
});

test("pending latest changes before 1.0 bump the core and keep -beta", () => {
  const { plan } = planVersions(
    { ...versions, runtime: "0.1.1-beta" },
    pins,
    [intent("runtime")],
    "latest"
  );
  assert.equal(plan.packages.runtime, "0.1.2-beta");
  assert.equal(plan.compatibility.runtime, "0.1.2-beta");
  assert.equal(plan.packages["create-agent"], "0.1.1-beta");
});

test("post-1.0 latest promotion strips -beta from the promoted package", () => {
  const before = {
    core: "1.0.0",
    cli: "1.0.0",
    harness: "1.0.0",
    agents: "1.0.0",
    runtime: "1.1.0-beta",
    studio: "1.0.0",
    "create-agent": "1.0.0",
  };
  assert.deepEqual(
    planVersions(
      before,
      { core: "1.0.0", cli: "1.0.0", harness: "1.0.0", agents: "1.0.0", runtime: "1.1.0-beta", studio: "1.0.0" },
      [],
      "latest"
    ).plan.packages,
    { runtime: "1.1.0", cli: "1.0.1", "create-agent": "1.0.1" }
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

test("a Harness release also advances Runtime and pins the canonical contracts together", () => {
  const { plan, changesets } = planVersions(versions, pins, [intent("harness", "minor")], "beta");
  assert.equal(plan.packages.harness, "0.11.0-beta");
  assert.equal(plan.packages.runtime, "0.1.1-beta");
  assert.equal(plan.compatibility.harness, plan.packages.harness);
  assert.ok(changesets.some(item => item.id === "release-runtime-harness"));
});


test("core releases propagate to both hosts and SDK without coupling engine releases to SDK", () => {
  const shared = planVersions(versions, pins, [intent("core", "minor")], "beta").plan;
  for (const name of ["core", "harness", "agents", "runtime", "studio", "cli", "create-agent"])
    assert.ok(shared.packages[name], `${name} must receive its updated dependency pin`);
  const engine = planVersions(versions, pins, [intent("harness")], "beta").plan;
  assert.equal(engine.packages.agents, undefined);
  assert.equal(engine.packages.studio, undefined);
  assert.ok(engine.packages.runtime);
  assert.ok(engine.packages.cli);
});
