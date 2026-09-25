import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  resolveLocalUiRoot,
  sha256File,
} from "../dist/local-ui.js";

async function makeBundle(webContents) {
  const dir = await mkdtemp(join(tmpdir(), "nylorun-ui-bundle-"));
  const webDir = join(dir, "web");
  await mkdir(webDir, { recursive: true });
  for (const [name, content] of Object.entries(webContents)) {
    const path = join(webDir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const bundlePath = join(dir, "bundle.tar");
  await new Promise((resolve, reject) => {
    const child = spawn("tar", ["-cf", bundlePath, "-C", webDir, "."], {
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exit ${code}`)),
    );
  });
  const sha256 = await sha256File(bundlePath);
  return {
    bundlePath,
    sha256,
    webDir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function startFixtureServer(bundlePath, onRequest) {
  let hits = 0;
  const body = await readFile(bundlePath);
  const server = createServer((request, response) => {
    hits += 1;
    onRequest?.();
    if (request.url !== "/v/0.8.0-beta/bundle.tar") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "content-type": "application/x-tar",
      "content-length": body.length,
    });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/v/0.8.0-beta/bundle.tar`,
    hits: () => hits,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

test("AC4: digest mismatch fails with expected and actual digests", async () => {
  const bundle = await makeBundle({
    "index.html": "<!doctype html><title>ui</title>",
  });
  const cacheDir = await mkdtemp(join(tmpdir(), "nylorun-ui-cache-"));
  const digestPath = join(cacheDir, "ui-digest.json");
  const wrong = createHash("sha256").update("not-the-bundle").digest("hex");
  await writeFile(
    digestPath,
    JSON.stringify({ version: "0.8.0-beta", sha256: wrong }),
  );
  const fixture = await startFixtureServer(bundle.bundlePath);
  try {
    await assert.rejects(
      () =>
        resolveLocalUiRoot({
          version: "0.8.0-beta",
          cacheDir,
          packagedRoot: join(cacheDir, "missing-web"),
          digestPath,
          bundleUrl: fixture.url,
        }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /digest mismatch/i);
        assert.match(error.message, new RegExp(wrong));
        assert.match(error.message, new RegExp(bundle.sha256));
        return true;
      },
    );
  } finally {
    await fixture.close();
    await bundle.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("AC4: second start is a cache hit with no network", async () => {
  const bundle = await makeBundle({
    "index.html": "<!doctype html><title>cached</title>",
  });
  const cacheDir = await mkdtemp(join(tmpdir(), "nylorun-ui-cache-"));
  const digestPath = join(cacheDir, "ui-digest.json");
  await writeFile(
    digestPath,
    JSON.stringify({ version: "0.8.0-beta", sha256: bundle.sha256 }),
  );
  const fixture = await startFixtureServer(bundle.bundlePath);
  const packagedRoot = join(cacheDir, "missing-web");
  try {
    const first = await resolveLocalUiRoot({
      version: "0.8.0-beta",
      cacheDir,
      packagedRoot,
      digestPath,
      bundleUrl: fixture.url,
    });
    assert.equal(fixture.hits(), 1);
    assert.match(await readFile(join(first, "index.html"), "utf8"), /cached/);

    const blockedFetch = async () => {
      throw new Error("network should not be used on cache hit");
    };
    const second = await resolveLocalUiRoot({
      version: "0.8.0-beta",
      cacheDir,
      packagedRoot,
      digestPath,
      bundleUrl: fixture.url,
      fetch: blockedFetch,
    });
    assert.equal(second, first);
    assert.equal(fixture.hits(), 1);
  } finally {
    await fixture.close();
    await bundle.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("AC4: corrupt cached bundle.tar is re-downloaded", async () => {
  const bundle = await makeBundle({
    "index.html": "<!doctype html><title>fresh</title>",
  });
  const cacheDir = await mkdtemp(join(tmpdir(), "nylorun-ui-cache-"));
  const digestPath = join(cacheDir, "ui-digest.json");
  await writeFile(
    digestPath,
    JSON.stringify({ version: "0.8.0-beta", sha256: bundle.sha256 }),
  );
  const cacheRoot = join(cacheDir, "studio", "0.8.0-beta");
  await mkdir(cacheRoot, { recursive: true });
  await writeFile(join(cacheRoot, "index.html"), "<!doctype html><title>stale</title>");
  await writeFile(join(cacheRoot, "bundle.tar"), "corrupt-not-a-tar");

  const fixture = await startFixtureServer(bundle.bundlePath);
  try {
    const resolved = await resolveLocalUiRoot({
      version: "0.8.0-beta",
      cacheDir,
      packagedRoot: join(cacheDir, "missing-web"),
      digestPath,
      bundleUrl: fixture.url,
    });
    assert.equal(fixture.hits(), 1);
    assert.match(await readFile(join(resolved, "index.html"), "utf8"), /fresh/);
    assert.equal(await sha256File(join(resolved, "bundle.tar")), bundle.sha256);
  } finally {
    await fixture.close();
    await bundle.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("AC4: concurrent starts leave one valid cache", async () => {
  const bundle = await makeBundle({
    "index.html": "<!doctype html><title>race</title>",
    "assets/app.js": "console.log(1)",
  });
  const cacheDir = await mkdtemp(join(tmpdir(), "nylorun-ui-cache-"));
  const digestPath = join(cacheDir, "ui-digest.json");
  await writeFile(
    digestPath,
    JSON.stringify({ version: "0.8.0-beta", sha256: bundle.sha256 }),
  );

  let releaseGate = () => {};
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let started = 0;
  const fixture = await startFixtureServer(bundle.bundlePath, () => {
    started += 1;
    if (started >= 2) releaseGate();
  });
  const packagedRoot = join(cacheDir, "missing-web");
  const options = {
    version: "0.8.0-beta",
    cacheDir,
    packagedRoot,
    digestPath,
    bundleUrl: fixture.url,
  };

  const slowFetch = async (input, init) => {
    const response = await fetch(input, init);
    await gate;
    return response;
  };

  try {
    const timer = setTimeout(() => releaseGate(), 2_000);
    const [a, b] = await Promise.all([
      resolveLocalUiRoot({ ...options, fetch: slowFetch }),
      resolveLocalUiRoot({ ...options, fetch: slowFetch }),
    ]);
    clearTimeout(timer);
    assert.equal(a, b);
    assert.match(await readFile(join(a, "index.html"), "utf8"), /race/);
    assert.equal(await sha256File(join(a, "bundle.tar")), bundle.sha256);
    assert.ok(fixture.hits() >= 1 && fixture.hits() <= 2);
  } finally {
    releaseGate();
    await fixture.close();
    await bundle.cleanup();
    await rm(cacheDir, { recursive: true, force: true });
  }
});

test("AC4: packaged dist/web wins without network or cacheDir", async () => {
  const packaged = await mkdtemp(join(tmpdir(), "nylorun-ui-packaged-"));
  await writeFile(
    join(packaged, "index.html"),
    "<!doctype html><title>packaged</title>",
  );
  try {
    const resolved = await resolveLocalUiRoot({
      version: "0.8.0-beta",
      packagedRoot: packaged,
      fetch: async () => {
        throw new Error("must not fetch when packaged web exists");
      },
    });
    assert.equal(resolved, packaged);
  } finally {
    await rm(packaged, { recursive: true, force: true });
  }
});
