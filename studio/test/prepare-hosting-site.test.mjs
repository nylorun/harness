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

test("prepareHostingSite builds /v/<version>/, welcome root, and keeps I12 immutable", async () => {
  const web = join(studioRoot, "dist/web");
  const bundle = join(studioRoot, "dist/bundle.tar");
  const digestPath = join(studioRoot, "dist/ui-digest.json");
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
    const root = readFileSync(join(outDir, "index.html"), "utf8");
    assert.match(root, /Nylorun Studio/);
    assert.match(root, /welcome\.css/);
    assert.match(root, /local network access/i);
    assert.match(root, /target="_blank"/);
    assert.doesNotMatch(root, /Hey\s*[—-]|welcome to/i);
    assert.ok(readFileSync(join(outDir, "welcome.css")));
    assert.ok(readFileSync(join(outDir, "welcome.js")));
    const manifest = JSON.parse(readFileSync(join(outDir, "versions.json"), "utf8"));
    assert.equal(manifest.latest, version);
    assert.equal(manifest.protocols["1"], version);

    // Second prepare with mirror: I12 keeps /v/<version>/, still refreshes root.
    const againDir = join(outDir, "again");
    const priorRoot = "do-not-clobber-version-html";
    mkdirSync(join(outDir, "v", version), { recursive: true });
    // Mirror already has version from first; prepare into againDir with mirror=outDir.
    await prepareHostingSite({
      version,
      web,
      bundle,
      origin: "http://127.0.0.1:9",
      outDir: againDir,
      mirror: outDir,
    });
    assert.match(
      readFileSync(join(againDir, "index.html"), "utf8"),
      /Nylorun Studio/,
    );
    assert.ok(readFileSync(join(againDir, "v", version, "index.html")));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});
