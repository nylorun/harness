import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareVersions,
  validatePlan,
  publishCandidates,
  verifyReleaseCommit,
  releaseNotes,
} from "../release/model.mjs";
import { root, readJson, writeJson, run } from "../lib/repo.mjs";

test("a Runtime beta release advances creator and preserves unrelated compatibility pins", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nylorun-release-test-"));
  try {
    await writeJson(join(directory, "package.json"), {
      name: "fixture",
      private: true,
      workspaces: ["harness", "runtime", "studio", "create-agent"],
    });
    // @manypkg/get-packages@3 NpmTool only treats a directory as an npm
    // workspace root when package-lock.json is present.
    await writeJson(join(directory, "package-lock.json"), {
      name: "fixture",
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": {
          name: "fixture",
          workspaces: ["harness", "runtime", "studio", "create-agent"],
        },
      },
    });
    await mkdir(join(directory, ".changeset"));
    await cp(
      join(root, ".changeset/config.json"),
      join(directory, ".changeset/config.json")
    );
    for (const [name, version] of Object.entries({
      harness: "0.10.0-beta.1",
      runtime: "0.1.0-beta.1",
      studio: "0.3.0-beta.1",
      "create-agent": "0.1.0-beta.1",
    })) {
      await mkdir(join(directory, name));
      await writeJson(join(directory, name, "package.json"), {
        name: `@nylorun/${name}`,
        version,
      });
    }
    await writeJson(join(directory, "create-agent/compatibility.json"), {
      harness: "0.10.0-beta.1",
      runtime: "0.1.0-beta.1",
      studio: "0.3.0-beta.1",
    });
    await writeFile(
      join(directory, ".changeset/runtime-fix.md"),
      '---\n"@nylorun/runtime": patch\n---\n\nFix runtime behavior.\n'
    );
    await writeFile(
      join(directory, ".changeset/already-released.md"),
      '---\n"@nylorun/runtime": major\n---\n\nAn already published change.\n'
    );
    await writeJson(join(directory, ".changeset/pre.json"), {
      mode: "pre",
      tag: "beta",
      initialVersions: {},
      changesets: ["already-released"],
    });
    await run("git", ["init", "-b", "main"], { cwd: directory, capture: true });
    await run("git", ["add", "."], { cwd: directory, capture: true });
    await run(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        "Fixture",
      ],
      { cwd: directory, capture: true }
    );
    const plan = await prepareVersions(directory, "beta");
    assert.deepEqual(plan.packages, {
      runtime: "0.1.1-beta",
      "create-agent": "0.1.1-beta",
    });
    assert.deepEqual(plan.compatibility, {
      harness: "0.10.0-beta.1",
      runtime: "0.1.1-beta",
      studio: "0.3.0-beta.1",
    });
    assert.match(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(join(directory, "create-agent/CHANGELOG.md"), "utf8")
      ),
      /compatibility/i
    );
    await validatePlan(plan, directory);
    assert.match(
      await releaseNotes(directory, "runtime", plan.packages.runtime),
      /Fix runtime behavior/
    );
    await assert.rejects(
      validatePlan(
        { ...plan, packages: { runtime: plan.packages.runtime } },
        directory
      ),
      /must include create-agent/
    );
    await assert.rejects(
      validatePlan({ ...plan, channel: "latest" }, directory),
      /does not match channel/
    );
    await assert.rejects(
      validatePlan(
        {
          ...plan,
          compatibility: { ...plan.compatibility, runtime: "0.1.0-beta.1" },
        },
        directory
      ),
      /Invalid compatibility pin/
    );
    assert.equal(
      (
        await readFile(join(directory, "runtime/CHANGELOG.md"), "utf8")
      ).includes("## 0.1.1-beta"),
      true
    );
    await assert.rejects(readFile(join(directory, ".changeset/pre.json")), {
      code: "ENOENT",
    });
    await assert.rejects(
      readFile(join(directory, ".changeset/runtime-fix.md")),
      { code: "ENOENT" }
    );
    await assert.rejects(
      readFile(join(directory, ".changeset/already-released.md")),
      { code: "ENOENT" }
    );
    assert.doesNotMatch(
      await releaseNotes(directory, "runtime", plan.packages.runtime),
      /already published/
    );
    for (const version of [
      "0.1.1-beta.1",
      "0.1.1-rc",
      "0.1.1-beta+build",
      "v0.1.1-beta",
    ]) {
      await assert.rejects(
        validatePlan(
          { ...plan, packages: { ...plan.packages, runtime: version } },
          directory
        ),
        /Invalid release package/
      );
    }
    const stable = await prepareVersions(directory, "latest");
    assert.equal(stable.packages.runtime, "0.1.1");
    assert.equal(stable.packages["create-agent"], "0.1.1");
    assert.equal(
      (await readJson(join(directory, "runtime/package.json"))).version,
      "0.1.1"
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication retries retain completed packages and never publish creator before its pins exist", async () => {
  const plan = {
    packages: { runtime: "0.1.1-beta", "create-agent": "0.1.1-beta" },
    channel: "beta",
    compatibility: {
      harness: "0.10.0-beta.1",
      runtime: "0.1.1-beta",
      studio: "0.3.0-beta.1",
    },
  };
  const artifacts = {
    runtime: { integrity: "runtime-hash", path: "runtime.tgz" },
    "create-agent": { integrity: "creator-hash", path: "creator.tgz" },
  };
  const published = new Map([
    ["harness", { integrity: "harness-hash" }],
    ["studio", { integrity: "studio-hash" }],
  ]);
  const calls = [];
  let failCreator = true;
  const registry = {
    lookup: async (name) => published.get(name),
    checkTag: async () => {},
    async publish(name) {
      calls.push(name);
      if (name === "create-agent" && failCreator)
        throw new Error("temporary registry failure");
      published.set(name, { integrity: artifacts[name].integrity });
    },
    waitFor: async (name) => published.get(name),
    ensureTag: async () => {},
  };
  await assert.rejects(
    publishCandidates(plan, artifacts, registry),
    /temporary registry failure/
  );
  assert.deepEqual(calls, ["runtime", "create-agent"]);
  failCreator = false;
  await publishCandidates(plan, artifacts, registry);
  assert.deepEqual(calls, ["runtime", "create-agent", "create-agent"]);
  published.set("runtime", { integrity: "different-hash" });
  await assert.rejects(
    publishCandidates(plan, artifacts, registry),
    /integrity conflict/
  );
  published.set("runtime", { integrity: "runtime-hash" });
  published.delete("create-agent");
  published.delete("studio");
  await assert.rejects(
    publishCandidates(plan, artifacts, registry),
    /pin is unavailable/
  );
});

test("release commit validation rejects unmerged or stale release plans", async () => {
  const directory = await mkdtemp(join(tmpdir(), "nylorun-release-git-"));
  const git = (args) => run("git", args, { cwd: directory, capture: true });
  try {
    await git(["init", "-b", "main"]);
    const commit = async (message) => {
      await git(["add", "."]);
      await git([
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "commit",
        "-m",
        message,
      ]);
      return git(["rev-parse", "HEAD"]);
    };
    await writeFile(join(directory, "README.md"), "fixture");
    await commit("Initial");
    await mkdir(join(directory, ".release"));
    await writeJson(join(directory, ".release/plan.json"), { version: 1 });
    const sha = await commit("Release");
    await git(["update-ref", "refs/remotes/origin/main", sha]);
    await verifyReleaseCommit(directory, sha);
    await assert.rejects(
      verifyReleaseCommit(directory, "main"),
      /full lowercase commit SHA/
    );
    await writeFile(join(directory, "README.md"), "later");
    const later = await commit("Unmerged");
    await assert.rejects(verifyReleaseCommit(directory, later));
    await git(["update-ref", "refs/remotes/origin/main", later]);
    await assert.rejects(
      verifyReleaseCommit(directory, later),
      /must introduce or update/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
