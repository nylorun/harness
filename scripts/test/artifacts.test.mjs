import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packages, writeJson } from "../lib/repo.mjs";
import { packRelease, readArtifacts } from "../release/artifacts.mjs";

test(
  "release artifacts are repeatable and modified bytes are rejected before publication",
  { timeout: 60_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "nylorun-artifact-test-"));
    try {
      const repo = join(temporary, "repo");
      const versions = Object.fromEntries(
        packages.map((name) => [name, "1.0.0-beta"]),
      );
      const compatibility = {
        harness: "1.0.0-beta",
        runtime: "1.0.0-beta",
        studio: "1.0.0-beta",
      };
      for (const name of packages) {
        await mkdir(join(repo, name), { recursive: true });
        await writeJson(join(repo, name, "package.json"), {
          name: `@nylorun/${name}`,
          version: versions[name],
          files: ["index.js"],
        });
        await writeFile(
          join(repo, name, "index.js"),
          "export const fixture = true;",
        );
      }
      await writeJson(
        join(repo, "create-agent/compatibility.json"),
        compatibility,
      );
      const plan = {
        version: 1,
        channel: "beta",
        packages: versions,
        compatibility,
      };
      const first = await packRelease(join(temporary, "first"), plan, repo);
      const second = await packRelease(join(temporary, "second"), plan, repo);
      assert.deepEqual(first, second);
      const verified = await readArtifacts(join(temporary, "first"), plan);
      await appendFile(verified.runtime.path, "tampered");
      await assert.rejects(
        readArtifacts(join(temporary, "first"), plan),
        /Artifact was modified: runtime/,
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
