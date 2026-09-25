import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { prepareHostingSite } from "../scripts/prepare-hosting-site.mjs";

const studioRoot = fileURLToPath(new URL("..", import.meta.url));

test("prepareHostingSite builds /v/<version>/ and refuses overwrite (I12)", async () => {
  const web = join(studioRoot, "dist/web");
  const bundle = join(studioRoot, "dist/bundle.tar");
  const digestPath = join(studioRoot, "dist/ui-digest.json");
  // Build artifacts must exist (npm test runs after build:server; check runs full build).
  // For isolated test runs, skip if web is missing.
  try {
    readFileSync(join(web, "index.html"));
    readFileSync(bundle);
    readFileSync(digestPath);
  } catch {
    return;
  }

  const outDir = mkdtempSync(join(tmpdir(), "studio-hosting-"));
  const version = `test-${Date.now()}`;
  try {
    const first = await prepareHostingSite({
      version,
      web,
      bundle,
      origin: "http://127.0.0.1:9",
      outDir,
    });
    assert.equal(first.version, version);
    assert.ok(readFileSync(join(outDir, "v", version, "index.html")));
    assert.ok(readFileSync(join(outDir, "v", version, "bundle.tar")));
    assert.ok(readFileSync(join(outDir, "index.html")));
    const manifest = JSON.parse(readFileSync(join(outDir, "versions.json"), "utf8"));
    assert.equal(manifest.latest, version);
    assert.equal(manifest.protocols["1"], version);

    await assert.rejects(
      () =>
        prepareHostingSite({
          version,
          web,
          bundle,
          origin: "http://127.0.0.1:9",
          outDir: join(outDir, "again"),
          mirror: outDir,
        }),
      /Refusing to overwrite/,
    );
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
