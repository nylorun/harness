/**
 * Runtime build packaging (D8).
 *
 *   node scripts/release/runtime-builds.mjs --local
 *     Build the current platform from the workspace into
 *     .tmp/runtime-builds/<platform>-<arch>/ (Node from process.execPath).
 *
 *   node scripts/release/runtime-builds.mjs --release
 *     Build one platform on its native runner: download the pinned Node (D6),
 *     verify SHASUMS256.txt, install packed runtime, write shims + manifest,
 *     and pack the @nylorun/runtime-<platform>-<arch> tarball.
 */
import { createHash } from "node:crypto";
import { createWriteStream, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import {
  assembleRuntimeBuild,
  currentPlatformArch,
  defaultBuildOut,
  localRuntimeBuild,
} from "../lib/local-build.mjs";
import { npm, readJson, root, run, verifyToolchain } from "../lib/repo.mjs";
import { assertRuntimePins, readPinnedNodeVersion } from "./pins.mjs";

const NODE_DIST = "https://nodejs.org/dist";

export function parseArgs(argv) {
  const args = argv.slice(2);
  const local = args.includes("--local");
  const release = args.includes("--release");
  const outIndex = args.indexOf("--out");
  const out = outIndex >= 0 ? args[outIndex + 1] : undefined;
  if (local === release)
    throw new Error(
      "Usage: node scripts/release/runtime-builds.mjs --local|--release [--out <dir>]",
    );
  if (outIndex >= 0 && !out)
    throw new Error("--out requires a directory path.");
  return { local, release, out };
}

async function readProtocolAndSchema(repo = root) {
  let protocol;
  let launcherProtocol = 1;
  try {
    const mod = await import(
      pathToFileURL(join(repo, "core/dist/compatibility.js")).href
    );
    protocol = {
      min: mod.HOST_PROTOCOL.min,
      max: mod.HOST_PROTOCOL.max,
      features: [...mod.HOST_PROTOCOL.features],
    };
    launcherProtocol = mod.LAUNCHER_PROTOCOL;
  } catch {
    const source = await readFile(
      join(repo, "core/src/compatibility.ts"),
      "utf8",
    );
    protocol = {
      min: Number(source.match(/\bmin\s*:\s*(\d+)/)[1]),
      max: Number(source.match(/\bmax\s*:\s*(\d+)/)[1]),
      features: [
        ...source
          .match(
            /export\s+const\s+PROTOCOL_FEATURES\s*=\s*\[([\s\S]*?)\]\s*as\s+const/,
          )[1]
          .matchAll(/"([^"]+)"/g),
      ].map((match) => match[1]),
    };
    launcherProtocol = Number(
      source.match(/export\s+const\s+LAUNCHER_PROTOCOL\s*=\s*(\d+)\s*;/)[1],
    );
  }
  const schemaSource = await readFile(
    join(repo, "runtime/src/tenant/schema.ts"),
    "utf8",
  );
  const tenantSchemaMax = Number(
    schemaSource.match(
      /export\s+const\s+TENANT_SCHEMA_VERSION\s*=\s*(\d+)\s*;/,
    )[1],
  );
  return { protocol, launcherProtocol, tenantSchemaMax };
}

function nodeDistSlug(platform, arch) {
  const os =
    platform === "win32" ? "win" : platform === "darwin" ? "darwin" : "linux";
  const cpu = arch === "x64" ? "x64" : "arm64";
  const ext = platform === "win32" ? "zip" : "tar.gz";
  return { os, cpu, ext, file: `node-v{VERSION}-${os}-${cpu}.${ext}` };
}

async function download(url, destination) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Download failed (${response.status}): ${url}`);
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(response.body, createWriteStream(destination));
}

async function verifyNodeSha256(version, fileName, archivePath) {
  const shasumsUrl = `${NODE_DIST}/v${version}/SHASUMS256.txt`;
  const response = await fetch(shasumsUrl);
  if (!response.ok)
    throw new Error(
      `Could not fetch Node SHASUMS256.txt for v${version} (${response.status}).`,
    );
  const text = await response.text();
  const line = text
    .split("\n")
    .find((entry) => entry.trimEnd().endsWith(`  ${fileName}`));
  if (!line)
    throw new Error(
      `SHASUMS256.txt has no entry for ${fileName} (Node v${version}).`,
    );
  const expected = line.trim().split(/\s+/)[0];
  const actual = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  if (actual !== expected)
    throw new Error(
      `Node archive sha256 mismatch for ${fileName}: expected ${expected}, got ${actual}.`,
    );
  return expected;
}

async function extractNodeArchive(archivePath, destination, { platform }) {
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  if (platform === "win32") {
    // Git Bash tar treats "C:" as a remote host unless --force-local is set.
    await run(
      "tar",
      ["--force-local", "-xf", archivePath, "-C", destination],
      { capture: true },
    );
  } else {
    await run("tar", ["-xzf", archivePath, "-C", destination], {
      capture: true,
    });
  }
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(destination);
  if (entries.length !== 1)
    throw new Error(`Unexpected Node archive layout in ${destination}.`);
  return join(destination, entries[0]);
}

/**
 * Download and verify the pinned Node, returning the path to its bin/node.
 */
export async function downloadPinnedNode({
  version,
  platform,
  arch,
  cacheDir,
}) {
  const { file } = nodeDistSlug(platform, arch);
  const fileName = file.replace("{VERSION}", version);
  const url = `${NODE_DIST}/v${version}/${fileName}`;
  const archivePath = join(cacheDir, fileName);
  await download(url, archivePath);
  await verifyNodeSha256(version, fileName, archivePath);
  const extractedRoot = await extractNodeArchive(
    archivePath,
    join(cacheDir, "extracted"),
    { platform },
  );
  const binary = join(
    extractedRoot,
    platform === "win32" ? "node.exe" : join("bin", "node"),
  );
  await chmod(binary, 0o755).catch(() => {});
  return { binary, extractedRoot, archivePath };
}

export async function buildRelease({ out } = {}) {
  await verifyToolchain();
  await assertRuntimePins(root);

  const { platform, arch } = currentPlatformArch();
  const nodeVersion = await readPinnedNodeVersion(root);
  const runtime = await readJson(join(root, "runtime/package.json"));
  const version = runtime.version;
  const destination = out ?? defaultBuildOut(platform, arch, root);
  const { protocol, launcherProtocol, tenantSchemaMax } =
    await readProtocolAndSchema(root);

  const cacheDir = join(
    tmpdir(),
    `nylorun-node-${nodeVersion}-${platform}-${arch}-${process.pid}`,
  );
  await mkdir(cacheDir, { recursive: true });
  try {
    const { binary, extractedRoot } = await downloadPinnedNode({
      version: nodeVersion,
      platform,
      arch,
      cacheDir,
    });

    const result = await assembleRuntimeBuild({
      out: destination,
      version,
      platform,
      arch,
      nodeVersion,
      nodeSourcePath: binary,
      protocol,
      launcherProtocol,
      tenantSchemaMax,
      windows: platform === "win32",
      repo: root,
    });

    const nodeDest = join(destination, "node");
    await rm(nodeDest, { recursive: true, force: true });
    await rename(extractedRoot, nodeDest);

    const packDir = join(root, ".tmp/runtime-builds");
    await mkdir(packDir, { recursive: true });
    const packed = JSON.parse(
      await npm(
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          packDir,
        ],
        { cwd: destination, capture: true },
      ),
    );
    const tarball = join(packDir, basename(packed[0].filename));
    console.log(
      JSON.stringify(
        {
          mode: "release",
          dir: result.dir,
          name: result.name,
          version: result.version,
          tarball,
          node: nodeVersion,
          platform,
          arch,
        },
        null,
        2,
      ),
    );
    return { ...result, tarball };
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

export async function buildLocal({ out } = {}) {
  await verifyToolchain();
  const result = await localRuntimeBuild({ out });
  console.log(
    JSON.stringify(
      {
        mode: "local",
        dir: result.dir,
        name: result.name,
        version: result.version,
        node: process.versions.node,
        execPath: process.execPath,
      },
      null,
      2,
    ),
  );
  return result;
}

async function main() {
  const { local, release, out } = parseArgs(process.argv);
  if (local) await buildLocal({ out });
  else await buildRelease({ out });
}

const invokedAsMain =
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedAsMain) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
