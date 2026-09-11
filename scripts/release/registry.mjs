import semver from "semver";
import { setTimeout as sleep } from "node:timers/promises";
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
  async waitFor(name, version, { sleep: pause = sleep } = {}) {
    // npm can accept a publish before several minutes of registry processing.
    for (let attempt = 0; attempt < 120; attempt++) {
      const value = await this.lookup(name, version);
      if (value) return value;
      await pause(5000);
    }
    throw new Error(
      `Registry has not exposed ${name}@${version}; retry this release later.`,
    );
  },
  async ensureTag(name, version, channel, { sleep: pause = sleep } = {}) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const tags = (await view(`@nylorun/${name}`, "dist-tags")) ?? {};
      if (tags[channel] === version) return;
      if (tags[channel] && semver.gt(tags[channel], version))
        throw new Error(
          `Refusing to move ${name}'s ${channel} tag backward from ${tags[channel]} to ${version}.`,
        );
      // First publish sets the tag via `npm publish --tag`. Retagging an already
      // published version (e.g. promote beta → latest) needs dist-tag add, which
      // requires a classic npm token (OIDC covers publish, not tag edits).
      if (attempt === 0 || attempt === 4) {
        try {
          await npm(
            ["dist-tag", "add", `@nylorun/${name}@${version}`, channel],
            { capture: true },
          );
          continue;
        } catch {
          // Keep polling; publish --tag may still be propagating, or an admin
          // token may be required for standalone tag edits.
        }
      }
      await pause(2000);
    }
    throw new Error(
      `Published ${name}@${version}, but its ${channel} tag differs. An npm administrator must run: npm dist-tag add @nylorun/${name}@${version} ${channel}`,
    );
  },
};
