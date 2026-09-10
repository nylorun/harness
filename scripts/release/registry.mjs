import semver from "semver";
import { setTimeout as delay } from "node:timers/promises";
import { npm } from "../lib/repo.mjs";

async function view(spec, field) {
  try {
    return JSON.parse(
      await npm(["view", spec, field, "--json"], { capture: true }),
    );
  } catch (error) {
    let response;
    try {
      response = JSON.parse(error.stdout);
    } catch {}
    if (response?.error?.code === "E404") return undefined;
    throw error;
  }
}
export const registry = {
  async checkTag(name, version, channel) {
    const tags = (await view(`@nylorun/${name}`, "dist-tags")) ?? {};
    if (tags[channel] && semver.gt(tags[channel], version))
      throw new Error(
        `Refusing to move ${name}'s ${channel} tag backward from ${tags[channel]} to ${version}.`,
      );
  },
  async lookup(name, version) {
    const dist = await view(`@nylorun/${name}@${version}`, "dist");
    return dist ? { integrity: dist.integrity } : undefined;
  },
  async publish(_name, path, channel) {
    await npm([
      "publish",
      path,
      "--access",
      "public",
      "--tag",
      channel,
      "--provenance",
      "--ignore-scripts",
    ]);
  },
  async waitFor(name, version) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const value = await this.lookup(name, version);
      if (value) return value;
      await delay(2000);
    }
    throw new Error(
      `Registry has not exposed ${name}@${version}; retry this release later.`,
    );
  },
  async ensureTag(name, version, channel) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const tags = (await view(`@nylorun/${name}`, "dist-tags")) ?? {};
      if (tags[channel] === version) return;
      if (tags[channel] && semver.gt(tags[channel], version))
        throw new Error(
          `Refusing to move ${name}'s ${channel} tag backward from ${tags[channel]} to ${version}.`,
        );
      await delay(2000);
    }
    // npm 11.15 exchanges OIDC credentials for publish, not dist-tag commands.
    throw new Error(
      `Published ${name}@${version}, but its ${channel} tag differs. An npm administrator must verify/correct the tag before retrying.`,
    );
  },
};
