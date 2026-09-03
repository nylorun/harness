import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGES = {
  harness: {
    manifestPath: "harness/package.json",
    lockPath: "harness",
    name: "@nylorun/harness",
    prereleaseId: "beta",
    tagPrefix: "v",
    title: "Harness",
  },
  studio: {
    manifestPath: "studio/package.json",
    lockPath: "studio",
    name: "@nylorun/studio",
    prereleaseId: "rc",
    tagPrefix: "studio-v",
    title: "Studio",
  },
};

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export const packageKeysForScope = (scope) => {
  if (scope === "both") return ["harness", "studio"];
  if (scope in PACKAGES) return [scope];
  throw new Error(`Unknown package scope: ${scope}`);
};

export const parseVersion = (version) => {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`Invalid semantic version: ${version}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
};

export const formatVersion = ({ major, minor, patch, prerelease }) =>
  `${major}.${minor}.${patch}${prerelease === undefined ? "" : `-${prerelease}`}`;

export const nextBetaVersion = (version, action, prereleaseId) => {
  const current = parseVersion(version);
  const next = { ...current, prerelease: `${prereleaseId}.0` };
  if (action === "major") {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (action === "minor") {
    next.minor += 1;
    next.patch = 0;
  } else if (action === "patch") {
    next.patch += 1;
  } else {
    throw new Error(
      `Beta releases require a major, minor, or patch action; received ${action}.`,
    );
  }
  return formatVersion(next);
};

export const promotedVersion = (version) => {
  const current = parseVersion(version);
  if (current.prerelease === undefined)
    throw new Error(
      `Stable promotion requires a beta or RC version; received ${version}.`,
    );
  return formatVersion({ ...current, prerelease: undefined });
};

export const calculateVersion = ({
  version,
  channel,
  action,
  prereleaseId,
}) => {
  if (channel === "beta") return nextBetaVersion(version, action, prereleaseId);
  if (channel === "stable") {
    if (action !== "promote")
      throw new Error(
        `Stable releases require the promote action; received ${action}.`,
      );
    return promotedVersion(version);
  }
  throw new Error(`Unknown release channel: ${channel}`);
};

export const createReleasePlan = ({ manifests, scope, channel, action }) =>
  packageKeysForScope(scope).map((key) => {
    const definition = PACKAGES[key];
    const currentVersion = manifests[key].version;
    const version = calculateVersion({
      version: currentVersion,
      channel,
      action,
      prereleaseId: definition.prereleaseId,
    });
    return { key, currentVersion, version, ...definition };
  });

export const validatePublishPlan = ({ manifests, scope }) =>
  packageKeysForScope(scope).map((key) => {
    const definition = PACKAGES[key];
    const version = manifests[key].version;
    const parsed = parseVersion(version);
    const expectedPrerelease = new RegExp(
      `^${definition.prereleaseId}\\.(0|[1-9]\\d*)$`,
    );
    if (
      parsed.prerelease !== undefined &&
      !expectedPrerelease.test(parsed.prerelease)
    )
      throw new Error(
        `${definition.title} prereleases must use ${definition.prereleaseId}.N; received ${version}.`,
      );
    return {
      key,
      version,
      distTag: parsed.prerelease === undefined ? "latest" : "beta",
      prerelease: parsed.prerelease !== undefined,
      ...definition,
    };
  });

export const readManifests = (root) =>
  Object.fromEntries(
    Object.entries(PACKAGES).map(([key, definition]) => [
      key,
      JSON.parse(readFileSync(resolve(root, definition.manifestPath), "utf8")),
    ]),
  );

export const applyReleasePlan = ({ root, plan }) => {
  const lockPath = resolve(root, "package-lock.json");
  const lockfile = JSON.parse(readFileSync(lockPath, "utf8"));
  for (const item of plan) {
    const manifestPath = resolve(root, item.manifestPath);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = item.version;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    lockfile.packages[item.lockPath].version = item.version;
  }
  writeFileSync(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`);
};

const parseArguments = (args) => {
  const values = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--"))
      throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    if (key === "write" || key === "publish" || key === "tsv")
      values[key] = true;
    else {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--"))
        throw new Error(`Missing value for ${argument}`);
      values[key] = value;
      index += 1;
    }
  }
  return values;
};

const releaseTitle = (plan) =>
  plan.map((item) => `${item.title} ${item.version}`).join(" and ");
const branchName = (plan) =>
  plan.map((item) => `${item.key}-${item.version}`).join("-");

const main = () => {
  const options = parseArguments(process.argv.slice(2));
  const root = resolve(options.root ?? ".");
  const manifests = readManifests(root);
  if (options.publish) {
    if (options.write)
      throw new Error("Publish validation cannot update package versions.");
    const plan = validatePublishPlan({ manifests, scope: options.scope });
    if (options.tsv) {
      for (const item of plan)
        console.log(
          [
            item.key,
            item.name,
            item.version,
            item.distTag,
            item.tagPrefix + item.version,
            item.prerelease,
          ].join("\t"),
        );
    } else console.log(JSON.stringify(plan));
    return;
  }

  const plan = createReleasePlan({
    manifests,
    scope: options.scope,
    channel: options.channel,
    action: options.action,
  });
  if (options.write) applyReleasePlan({ root, plan });
  console.log(
    JSON.stringify({
      plan,
      title: releaseTitle(plan),
      branch: branchName(plan),
    }),
  );
};

if (import.meta.url === new URL(process.argv[1], "file:").href) main();
