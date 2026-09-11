import semver from "semver";
import { packages } from "../lib/repo.mjs";

const impact = { none: 0, patch: 1, minor: 2, major: 3 };
const fullName = (name) => `@nylorun/${name}`;
const core = (version) => {
  const parsed = semver.parse(version);
  if (!parsed) throw new Error(`Invalid current version: ${version}`);
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
};

/**
 * Pre-1.0 product branding always uses a `-beta` version suffix.
 * After 1.0, only the npm `beta` channel uses `-beta` (staging before latest).
 * npm channels (`beta` vs `latest`) are independent of that branding.
 */
const suffixFor = (nextCore, channel) => {
  if (semver.major(nextCore) === 0) return "-beta";
  return channel === "beta" ? "-beta" : "";
};

/** Compute final versions once; Changesets applies this exact plan and writes notes. */
export function planVersions(before, compatibility, pending, channel) {
  if (!["beta", "latest"].includes(channel))
    throw new Error("Choose --channel beta or --channel latest.");
  for (const name of packages) core(before[name]);
  if (
    !compatibility ||
    Object.keys(compatibility).length !== 3 ||
    ["harness", "runtime", "studio"].some(
      (name) => !semver.valid(compatibility[name])
    )
  )
    throw new Error(
      "Compatibility must contain exactly three valid package pins."
    );
  const changesets = [...pending];
  const bumps = new Map();
  for (const changeset of pending) {
    for (const release of changeset.releases) {
      const name = packages.find((name) => fullName(name) === release.name);
      if (!name || !Object.hasOwn(impact, release.type))
        throw new Error(
          `Unsupported changeset release: ${release.name} ${release.type}`
        );
      // Before 1.0, breaking changes start the next minor series.
      const type =
        release.type === "major" && semver.major(before[name]) === 0
          ? "minor"
          : release.type;
      if (impact[type] > (impact[bumps.get(name)] ?? 0)) bumps.set(name, type);
    }
  }
  const versions = {};
  const bump = (name, type) => {
    const next = semver.inc(core(before[name]), type);
    return next + suffixFor(next, channel);
  };
  for (const name of packages) {
    const type = bumps.get(name);
    if (type) versions[name] = bump(name, type);
    else if (
      channel === "latest" &&
      bumps.size === 0 &&
      semver.prerelease(before[name])
    ) {
      if (semver.major(before[name]) === 0) {
        // Pre-1.0: promote by pointing `latest` at the same x.y.z-beta version.
        // Ignore legacy numbered betas (0.1.0-beta.1); those are not the modern line.
        if (/^\d+\.\d+\.\d+-beta$/.test(before[name]))
          versions[name] = before[name];
      } else {
        // Post-1.0: classic promote strips the prerelease.
        versions[name] = core(before[name]);
      }
    }
  }
  if (!Object.keys(versions).length)
    throw new Error(
      "No pending changesets or beta versions to promote. Add release intent with npm run changeset first."
    );

  if (packages.some((name) => name !== "create-agent" && versions[name])) {
    if (!versions["create-agent"]) {
      bumps.set("create-agent", "patch");
      versions["create-agent"] = bump("create-agent", "patch");
    }
    changesets.push({
      id: "release-creator-compatibility",
      summary:
        "Update the tested Harness, Runtime, and Studio compatibility combination.",
      releases: [{ name: fullName("create-agent"), type: "patch" }],
    });
  }
  for (const name of packages) {
    if (versions[name] && !bumps.has(name)) {
      const tagOnly =
        channel === "latest" &&
        versions[name] === before[name] &&
        semver.major(before[name]) === 0;
      changesets.push({
        id: `release-stable-${name}`,
        summary: tagOnly
          ? `Publish the tested ${before[name]} release on the latest dist-tag.`
          : `Promote the tested ${before[name]} release to stable.`,
        releases: [{ name: fullName(name), type: "patch" }],
      });
    }
  }
  const pinned = { ...compatibility };
  const releases = packages
    .filter((name) => versions[name])
    .map((name) => {
      if (semver.lt(versions[name], before[name]))
        throw new Error(
          `Version must not go backward: ${name} ${before[name]} → ${versions[name]}`
        );
      if (
        versions[name] === before[name] &&
        !(channel === "latest" && semver.major(before[name]) === 0)
      )
        throw new Error(
          `Version must advance: ${name} ${before[name]} → ${versions[name]}`
        );
      if (
        versions[name] !== before[name] &&
        !semver.gt(versions[name], before[name])
      )
        throw new Error(
          `Version must advance: ${name} ${before[name]} → ${versions[name]}`
        );
      if (name !== "create-agent") pinned[name] = versions[name];
      return {
        name: fullName(name),
        type: bumps.get(name) ?? "patch",
        oldVersion: before[name],
        newVersion: versions[name],
        changesets: changesets
          .filter((item) =>
            item.releases.some((release) => release.name === fullName(name))
          )
          .map((item) => item.id),
      };
    });
  return {
    plan: {
      version: 1,
      channel,
      packages: Object.fromEntries(
        packages
          .filter((name) => versions[name])
          .map((name) => [name, versions[name]])
      ),
      compatibility: pinned,
    },
    changesets,
    releases,
  };
}
