import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import semver from "semver";
import applyReleasePlan from "@changesets/apply-release-plan";
import readChangesets from "@changesets/read";
import { readConfig } from "@changesets/config";
import { getPackages } from "@manypkg/get-packages";
import { root, packages, readJson, writeJson, run } from "../lib/repo.mjs";
import { planVersions } from "./version-policy.mjs";

/** Adapt manypkg v3 graphs for @changesets/apply-release-plan@7 (expects root + tool string). */
function packagesForApplyReleasePlan(workspace) {
  return {
    tool:
      typeof workspace.tool === "string"
        ? workspace.tool
        : (workspace.tool?.type ?? "root"),
    packages: workspace.packages,
    root: workspace.rootPackage ?? workspace.root,
  };
}

export async function prepareVersions(repo, channel) {
  const workspace = await getPackages(repo);
  // @changesets/config v4 discovers packages itself (manypkg v3 rootDir graphs).
  // apply-release-plan@7 still wants the older Packages shape (root + tool string).
  const { config, errors } = await readConfig(repo);
  if (config == null) {
    throw new Error(
      errors?.length ? errors.join("\n") : "Invalid @changesets/config",
    );
  }
  if (config.fixed.length || config.linked.length || config.ignore.length)
    throw new Error(
      "Release policy requires independently versioned, non-ignored packages."
    );
  const before = Object.fromEntries(
    await Promise.all(
      packages.map(async (name) => [
        name,
        (await readJson(join(repo, name, "package.json"))).version,
      ])
    )
  );
  const compatibility = await readJson(
    join(repo, "create-agent/compatibility.json")
  );
  let legacy;
  try {
    legacy = await readJson(join(repo, ".changeset/pre.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (legacy && (legacy.tag !== "beta" || !Array.isArray(legacy.changesets)))
    throw new Error("Unsupported legacy prerelease state.");
  const allChangesets = await readChangesets(repo);
  const consumed = new Set(legacy?.changesets ?? []);
  const pending = allChangesets.filter((item) => !consumed.has(item.id));
  const calculated = planVersions(before, compatibility, pending, channel);
  const tagOnly = calculated.releases.every(
    (release) => release.oldVersion === release.newVersion
  );
  if (!tagOnly) {
    await applyReleasePlan(
      {
        changesets: calculated.changesets,
        releases: calculated.releases,
        preState: undefined,
      },
      packagesForApplyReleasePlan(workspace),
      config,
      undefined,
      root
    );
    // Numbered prerelease state is retired; already-applied changes must not replay.
    if (legacy) {
      for (const item of allChangesets.filter((item) => consumed.has(item.id)))
        await rm(join(repo, ".changeset", `${item.id}.md`));
      await rm(join(repo, ".changeset/pre.json"));
    }
    await writeJson(
      join(repo, "create-agent/compatibility.json"),
      calculated.plan.compatibility
    );
  } else if (legacy) {
    throw new Error(
      "Clear legacy prerelease state before a latest dist-tag promotion."
    );
  }
  await validatePlan(calculated.plan, repo);
  for (const [name, version] of Object.entries(calculated.plan.packages))
    await releaseNotes(repo, name, version);
  return calculated.plan;
}

export async function validatePlan(plan, repo) {
  if (
    plan?.version !== 1 ||
    !["beta", "latest"].includes(plan.channel) ||
    !plan.packages ||
    !Object.keys(plan.packages).length
  )
    throw new Error("Invalid release plan.");
  if (!plan.packages["create-agent"])
    throw new Error("Every release must include create-agent.");
  for (const [name, version] of Object.entries(plan.packages)) {
    if (
      !packages.includes(name) ||
      typeof version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-beta)?$/.test(version) ||
      !semver.valid(version)
    )
      throw new Error(`Invalid release package/version: ${name}`);
    const prerelease = semver.prerelease(version);
    if (plan.channel === "beta") {
      if (prerelease?.length !== 1 || prerelease[0] !== "beta")
        throw new Error(
          `Version ${version} does not match channel ${plan.channel}.`
        );
    } else if (plan.channel === "latest") {
      // Pre-1.0 latest keeps *-beta product branding; post-1.0 latest is stable.
      if (semver.major(version) === 0) {
        if (prerelease?.length !== 1 || prerelease[0] !== "beta")
          throw new Error(
            `Pre-1.0 latest versions must use the -beta product suffix: ${version}`
          );
      } else if (prerelease) {
        throw new Error(
          `Version ${version} does not match channel ${plan.channel}.`
        );
      }
    }
    if ((await readJson(join(repo, name, "package.json"))).version !== version)
      throw new Error(`Release version differs from ${name}/package.json.`);
  }
  const actual = await readJson(join(repo, "create-agent/compatibility.json"));
  for (const name of ["harness", "runtime", "studio"]) {
    const version = plan.compatibility?.[name];
    if (
      !semver.valid(version) ||
      actual[name] !== version ||
      (plan.packages[name] && plan.packages[name] !== version)
    )
      throw new Error(`Invalid compatibility pin for ${name}.`);
  }
  if (Object.keys(plan.compatibility).length !== 3)
    throw new Error(
      "Compatibility must contain exactly Harness, Runtime, and Studio."
    );
}

export async function releaseNotes(repo, name, version) {
  const lines = (
    await readFile(join(repo, name, "CHANGELOG.md"), "utf8")
  ).split("\n");
  const start = lines.findIndex(
    (line) => line === `## ${version}` || line.startsWith(`## [${version}]`)
  );
  if (start === -1)
    throw new Error(`Missing changelog entry for ${name}@${version}.`);
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith("## ")) end++;
  return lines.slice(start, end).join("\n").trim();
}

/** Registry boundary: retries may skip only byte-identical completed publications. */
export async function publishCandidates(
  plan,
  artifacts,
  registry,
  report = () => {}
) {
  for (const name of packages.filter((name) => plan.packages[name]))
    await registry.checkTag(name, plan.packages[name], plan.channel);
  for (const name of packages.filter((name) => plan.packages[name])) {
    const artifact = artifacts[name];
    if (!artifact?.integrity)
      throw new Error(`Missing verified artifact for ${name}.`);
    const version = plan.packages[name];
    const published = await registry.lookup(name, version);
    if (published) {
      if (published.integrity !== artifact.integrity)
        throw new Error(`Published integrity conflict for ${name}@${version}.`);
      report(`${name}@${version}: already published with matching integrity`);
    } else {
      if (name === "create-agent") {
        for (const engine of ["harness", "runtime", "studio"]) {
          if (!(await registry.lookup(engine, plan.compatibility[engine])))
            throw new Error(
              `Creator pin is unavailable: ${engine}@${plan.compatibility[engine]}`
            );
        }
      }
      await registry.publish(name, artifact.path, plan.channel);
      const verified = await registry.waitFor(name, version);
      if (verified?.integrity !== artifact.integrity)
        throw new Error(`Registry verification failed for ${name}@${version}.`);
      report(`${name}@${version}: published and verified`);
    }
    await registry.ensureTag(name, version, plan.channel);
  }
}

export async function verifyReleaseCommit(repo, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? ""))
    throw new Error("Release requires a full lowercase commit SHA.");
  await run("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
    cwd: repo,
    capture: true,
  });
  const head = await run("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    capture: true,
  });
  if (head !== sha)
    throw new Error("Checkout does not match the requested release commit.");
  const diff = await run(
    "git",
    ["diff", "--name-only", `${sha}^`, sha, "--", ".release/plan.json"],
    { cwd: repo, capture: true }
  );
  if (!diff)
    throw new Error(
      "The selected commit must introduce or update the release plan."
    );
  await readFile(join(repo, ".release/plan.json"));
}
