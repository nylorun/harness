/**
 * Local npm-compatible registry fixture for Runtime build packages.
 * Serves packuments, version metadata, and tarballs with SRI integrity.
 * Tests point NYLORUN_REGISTRY at the returned url (D9).
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { npm, readJson } from "./repo.mjs";

async function integrityOf(path) {
  return `sha512-${createHash("sha512")
    .update(await readFile(path))
    .digest("base64")}`;
}

function shasumOf(buffer) {
  return createHash("sha1").update(buffer).digest("hex");
}

function encodeName(name) {
  if (name.startsWith("@")) {
    const slash = name.indexOf("/");
    if (slash === -1) return encodeURIComponent(name);
    return `${name.slice(0, slash)}%2f${name.slice(slash + 1)}`;
  }
  return encodeURIComponent(name);
}

function decodePathPackage(pathname) {
  // /@scope%2fname[/version] or /@scope/name[/version] or /name[/version]
  let rest = pathname.replace(/^\/+/, "");
  if (!rest) return undefined;
  try {
    rest = decodeURIComponent(rest);
  } catch {
    return undefined;
  }
  if (rest.startsWith("@")) {
    const slash = rest.indexOf("/");
    if (slash === -1) return { name: rest };
    const after = rest.slice(slash + 1);
    const next = after.indexOf("/");
    if (next === -1) return { name: rest };
    return {
      name: rest.slice(0, slash + 1 + next),
      version: after.slice(next + 1),
    };
  }
  const slash = rest.indexOf("/");
  if (slash === -1) return { name: rest };
  return { name: rest.slice(0, slash), version: rest.slice(slash + 1) };
}

async function packBuild(dir, destination) {
  await mkdir(destination, { recursive: true });
  const result = JSON.parse(
    await npm(
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      { cwd: dir, capture: true },
    ),
  );
  const file = result[0]?.filename;
  if (!file) throw new Error(`npm pack produced no tarball for ${dir}`);
  const path = join(destination, basename(file));
  const bytes = await readFile(path);
  return {
    path,
    filename: basename(file),
    integrity: await integrityOf(path),
    shasum: shasumOf(bytes),
    size: bytes.length,
  };
}

/**
 * @param {{ builds: Array<{ name: string, version: string, dir: string }> }} options
 * @returns {Promise<{ url: string, close(): Promise<void>, tarballPath(name: string, version: string): string }>}
 */
export async function startLocalRegistry({ builds }) {
  if (!Array.isArray(builds) || builds.length === 0)
    throw new Error("startLocalRegistry requires a non-empty builds array.");

  const cache = join(
    tmpdir(),
    `nylorun-local-registry-${process.pid}-${Date.now()}`,
  );
  await mkdir(cache, { recursive: true });

  /** @type {Map<string, { name: string, versions: Map<string, object>, tarballs: Map<string, { path: string, filename: string }> }>} */
  const packages = new Map();

  for (const build of builds) {
    if (!build?.name || !build?.version || !build?.dir)
      throw new Error("Each build needs name, version, and dir.");
    const manifest = await readJson(join(build.dir, "package.json"));
    if (manifest.name !== build.name)
      throw new Error(
        `Build directory package name ${manifest.name} does not match ${build.name}.`,
      );
    if (manifest.version !== build.version)
      throw new Error(
        `Build directory version ${manifest.version} does not match ${build.version}.`,
      );

    const packed = await packBuild(build.dir, cache);
    let entry = packages.get(build.name);
    if (!entry) {
      entry = { name: build.name, versions: new Map(), tarballs: new Map() };
      packages.set(build.name, entry);
    }
    entry.tarballs.set(build.version, {
      path: packed.path,
      filename: packed.filename,
    });
    entry.versions.set(build.version, {
      name: build.name,
      version: build.version,
      dist: {
        integrity: packed.integrity,
        shasum: packed.shasum,
        tarball: null,
        unpackedSize: packed.size,
      },
    });
  }

  const sendJson = (response, status, body) => {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
      "cache-control": "no-store",
    });
    response.end(payload);
  };

  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host ?? "127.0.0.1";
      const url = new URL(request.url ?? "/", `http://${host}`);
      const pathname = url.pathname;

      const tarballMatch = pathname.match(
        /^\/((?:@[^/]+\/)?[^/]+)\/-\/([^/]+\.tgz)$/,
      );
      if (tarballMatch) {
        let packageName = tarballMatch[1];
        try {
          packageName = decodeURIComponent(packageName);
        } catch {
          /* keep */
        }
        const filename = tarballMatch[2];
        const entry = packages.get(packageName);
        if (!entry) {
          sendJson(response, 404, { error: "not_found", package: packageName });
          return;
        }
        for (const tarball of entry.tarballs.values()) {
          if (tarball.filename === filename) {
            response.writeHead(200, {
              "content-type": "application/octet-stream",
              "cache-control": "no-store",
            });
            createReadStream(tarball.path).pipe(response);
            return;
          }
        }
        sendJson(response, 404, { error: "not_found", tarball: filename });
        return;
      }

      const parsed = decodePathPackage(pathname);
      if (!parsed?.name) {
        sendJson(response, 404, { error: "not_found" });
        return;
      }
      const entry = packages.get(parsed.name);
      if (!entry) {
        sendJson(response, 404, { error: "not_found", package: parsed.name });
        return;
      }

      const base = `http://${host}`;
      const encoded = encodeName(entry.name);

      if (parsed.version) {
        const version = parsed.version.split("/")[0];
        const meta = entry.versions.get(version);
        if (!meta) {
          sendJson(response, 404, {
            error: "not_found",
            package: entry.name,
            version,
          });
          return;
        }
        const tarball = entry.tarballs.get(version);
        sendJson(response, 200, {
          ...meta,
          dist: {
            ...meta.dist,
            tarball: `${base}/${encoded}/-/${tarball.filename}`,
          },
        });
        return;
      }

      const versions = {};
      const times = {};
      let latest;
      for (const [version, meta] of entry.versions) {
        const tarball = entry.tarballs.get(version);
        versions[version] = {
          ...meta,
          dist: {
            ...meta.dist,
            tarball: `${base}/${encoded}/-/${tarball.filename}`,
          },
        };
        times[version] = new Date().toISOString();
        latest = version;
      }
      sendJson(response, 200, {
        name: entry.name,
        "dist-tags": { latest },
        versions,
        time: { modified: times[latest], ...times },
      });
    } catch (error) {
      sendJson(response, 500, {
        error: "internal",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local registry failed to bind a TCP port.");
  const url = `http://127.0.0.1:${address.port}`;

  return {
    url,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(cache, { recursive: true, force: true });
    },
    tarballPath(name, version) {
      const entry = packages.get(name);
      const tarball = entry?.tarballs.get(version);
      if (!tarball)
        throw new Error(`No tarball for ${name}@${version} in local registry.`);
      return tarball.path;
    },
  };
}
