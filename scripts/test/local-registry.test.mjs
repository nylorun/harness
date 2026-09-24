import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startLocalRegistry } from "../lib/local-registry.mjs";
import { writeJson } from "../lib/repo.mjs";

async function fixtureBuild(root, { name, version }) {
  const dir = join(root, "pkg");
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "package.json"), {
    name,
    version,
    files: ["manifest.json", "bin", "greeting.txt"],
  });
  await writeFile(join(dir, "greeting.txt"), "hello-runtime-build\n");
  await writeJson(join(dir, "manifest.json"), {
    format: 1,
    runtimeVersion: version,
  });
  await mkdir(join(dir, "bin"), { recursive: true });
  await writeFile(join(dir, "bin/nylorun-runtime"), "#!/bin/sh\necho ok\n");
  return dir;
}

test("startLocalRegistry serves packument, version metadata, and SRI tarball", async () => {
  const root = await mkdtemp(join(tmpdir(), "nylorun-registry-"));
  const name = "@nylorun/runtime-linux-x64";
  const version = "0.9.0-beta";
  try {
    const dir = await fixtureBuild(root, { name, version });
    const registry = await startLocalRegistry({
      builds: [{ name, version, dir }],
    });
    try {
      const encoded = "@nylorun%2fruntime-linux-x64";
      const versionMeta = await fetch(
        `${registry.url}/${encoded}/${version}`,
      ).then((response) => {
        assert.equal(response.status, 200);
        return response.json();
      });
      assert.equal(versionMeta.name, name);
      assert.equal(versionMeta.version, version);
      assert.match(versionMeta.dist.integrity, /^sha512-/);
      assert.match(
        versionMeta.dist.tarball,
        new RegExp(`${encoded}/-/.+\\.tgz$`),
      );

      const packument = await fetch(`${registry.url}/${encoded}`).then(
        (response) => {
          assert.equal(response.status, 200);
          return response.json();
        },
      );
      assert.equal(packument["dist-tags"].latest, version);
      assert.equal(
        packument.versions[version].dist.integrity,
        versionMeta.dist.integrity,
      );

      const tarball = await fetch(versionMeta.dist.tarball).then(
        async (response) => {
          assert.equal(response.status, 200);
          return Buffer.from(await response.arrayBuffer());
        },
      );
      const integrity = `sha512-${createHash("sha512")
        .update(tarball)
        .digest("base64")}`;
      assert.equal(integrity, versionMeta.dist.integrity);

      const localPath = registry.tarballPath(name, version);
      assert.equal(
        `sha512-${createHash("sha512")
          .update(await readFile(localPath))
          .digest("base64")}`,
        versionMeta.dist.integrity,
      );
    } finally {
      await registry.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("startLocalRegistry rejects empty builds", async () => {
  await assert.rejects(
    () => startLocalRegistry({ builds: [] }),
    /non-empty builds/,
  );
});
