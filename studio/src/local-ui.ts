import {
  access,
  constants as fsConstants,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawn } from "node:child_process";
import type { ServerResponse } from "node:http";
import { HOSTED_ORIGIN } from "./contract.js";

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
});

/** Packaged dashboard root (`dist/web`) beside this module's compile output. */
export function packagedWebRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "web");
}

/** Packaged digest (`dist/ui-digest.json`) beside this module's compile output. */
export function packagedDigestPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "ui-digest.json");
}

export type UiDigest = Readonly<{ version: string; sha256: string }>;

export type ResolveLocalUiOptions = Readonly<{
  /** Proxy version; cache path and default download URL use this. */
  version: string;
  /** Host data directory (CLI `resolveHome`); never `process.cwd()`. */
  cacheDir?: string;
  /** Override packaged `dist/web` (tests). */
  packagedRoot?: string;
  /** Override path to `ui-digest.json` (tests). */
  digestPath?: string;
  /** Override bundle download URL (tests). */
  bundleUrl?: string;
  /** Override `fetch` (tests). */
  fetch?: typeof globalThis.fetch;
}>;

export function staticPath(root: string, pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0")) return undefined;
  const candidate = resolve(root, decoded.replace(/^\/+/, "") || "index.html");
  return candidate === root || candidate.startsWith(`${root}${sep}`)
    ? candidate
    : undefined;
}

function staticHeaders(file: string): Record<string, string> {
  const immutable = file.includes(`${sep}assets${sep}`);
  return {
    "content-type": MIME_TYPES[extname(file)] ?? "application/octet-stream",
    "cache-control": immutable
      ? "public, max-age=31536000, immutable"
      : "no-store",
    "x-content-type-options": "nosniff",
  };
}

export async function sendFile(
  response: ServerResponse,
  method: string,
  file: string,
): Promise<boolean> {
  try {
    const content = await readFile(file);
    response.writeHead(200, staticHeaders(file));
    response.end(method === "HEAD" ? undefined : content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Serves the local-mode dashboard from `root` with today's static-file rules
 * (SPA fallback to index.html). Returns true when the response was completed.
 */
export async function serveLocalUi(
  response: ServerResponse,
  method: string,
  pathname: string,
  root: string,
  reject: (status: number, message: string) => void,
): Promise<void> {
  const target = staticPath(root, pathname);
  if (target === undefined) {
    reject(400, "Invalid Studio asset path.");
    return;
  }
  if (await sendFile(response, method, target)) return;
  if (extname(target) !== "") {
    reject(404, "Studio asset not found.");
    return;
  }
  if (!(await sendFile(response, method, join(root, "index.html"))))
    reject(
      500,
      "Studio distribution is missing. Reinstall or rebuild @nylorun/studio.",
    );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `root` looks like a built dashboard (`index.html` present). */
export async function hasWebRoot(root: string): Promise<boolean> {
  return pathExists(join(root, "index.html"));
}

export async function readUiDigest(path: string): Promise<UiDigest> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Studio UI digest missing or unreadable at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof (raw as { version?: unknown }).version !== "string" ||
    typeof (raw as { sha256?: unknown }).sha256 !== "string" ||
    !(raw as { sha256: string }).sha256
  ) {
    throw new Error(
      `Studio UI digest at ${path} must be { version: string, sha256: string }.`,
    );
  }
  return Object.freeze({
    version: (raw as { version: string }).version,
    sha256: (raw as { sha256: string }).sha256.toLowerCase(),
  });
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

async function assertBundleDigest(
  bundlePath: string,
  expectedSha256: string,
): Promise<void> {
  const actual = await sha256File(bundlePath);
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `Studio UI bundle digest mismatch: expected ${expectedSha256.toLowerCase()}, got ${actual}.`,
    );
  }
}

async function tryValidCache(
  cacheRoot: string,
  expectedSha256: string,
): Promise<string | undefined> {
  const bundlePath = join(cacheRoot, "bundle.tar");
  if (!(await hasWebRoot(cacheRoot))) return undefined;
  if (!(await pathExists(bundlePath))) return undefined;
  try {
    await assertBundleDigest(bundlePath, expectedSha256);
    return cacheRoot;
  } catch {
    return undefined;
  }
}

async function downloadToFile(
  url: string,
  destination: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<void> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(
      `Studio UI bundle download failed (${response.status}) from ${url}.`,
    );
  }
  if (!response.body) {
    throw new Error(`Studio UI bundle download returned an empty body from ${url}.`);
  }
  await pipeline(
    Readable.fromWeb(response.body as import("node:stream/web").ReadableStream),
    createWriteStream(destination),
  );
}

async function extractBundle(bundlePath: string, destination: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("tar", ["-xf", bundlePath, "-C", destination], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      reject(
        new Error(
          `Failed to extract Studio UI bundle (tar unavailable?): ${error.message}`,
        ),
      );
    });
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        reject(
          new Error(
            `Studio UI bundle extraction failed (${code}).${
              stderr ? `\n${stderr.trim()}` : ""
            }`,
          ),
        );
    });
  });
}

/**
 * Local-mode resolution (design §10 / P9):
 * `dist/web` → cache → download hosted `bundle.tar` → verify SHA-256 → atomic extract.
 */
export async function resolveLocalUiRoot(
  options: ResolveLocalUiOptions,
): Promise<string> {
  const packaged = options.packagedRoot ?? packagedWebRoot();
  if (await hasWebRoot(packaged)) return packaged;

  const cacheDir = options.cacheDir?.trim();
  if (!cacheDir) {
    throw new Error(
      "Studio local UI requires cacheDir when dist/web is absent. Pass the CLI Host data directory.",
    );
  }

  const digestPath = options.digestPath ?? packagedDigestPath();
  const digest = await readUiDigest(digestPath);
  const version = options.version;
  const studioCacheParent = join(cacheDir, "studio");
  const cacheRoot = join(studioCacheParent, version);

  const hit = await tryValidCache(cacheRoot, digest.sha256);
  if (hit) return hit;

  const bundleUrl =
    options.bundleUrl ?? `${HOSTED_ORIGIN}/v/${version}/bundle.tar`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const tmpRoot = join(
    studioCacheParent,
    `${version}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`,
  );

  await mkdir(studioCacheParent, { recursive: true });
  await mkdir(tmpRoot, { recursive: true });
  const bundlePath = join(tmpRoot, "bundle.tar");
  try {
    await downloadToFile(bundleUrl, bundlePath, fetchImpl);
    await assertBundleDigest(bundlePath, digest.sha256);
    await extractBundle(bundlePath, tmpRoot);
    if (!(await hasWebRoot(tmpRoot))) {
      throw new Error(
        "Studio UI bundle did not contain index.html after extraction.",
      );
    }

    // Another process may have published while we downloaded.
    const raced = await tryValidCache(cacheRoot, digest.sha256);
    if (raced) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      return raced;
    }

    // Replace corrupt/partial cache, then rename atomically (P9).
    await rm(cacheRoot, { recursive: true, force: true }).catch(() => {});
    try {
      await rename(tmpRoot, cacheRoot);
    } catch {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      const winner = await tryValidCache(cacheRoot, digest.sha256);
      if (winner) return winner;
      throw new Error(
        "Studio UI cache was not ready after a concurrent extract. Retry.",
      );
    }
    return cacheRoot;
  } catch (error) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** Test helper: stage a pre-verified cache directory (bundle.tar + web files). */
export async function stageLocalUiCache(options: {
  cacheDir: string;
  version: string;
  bundlePath: string;
  webRoot: string;
}): Promise<string> {
  const cacheRoot = join(options.cacheDir, "studio", options.version);
  await mkdir(cacheRoot, { recursive: true });
  await copyFile(options.bundlePath, join(cacheRoot, "bundle.tar"));
  // Copy web files (shallow: index + nested via tar extract already preferred).
  const { cp } = await import("node:fs/promises");
  await cp(options.webRoot, cacheRoot, { recursive: true });
  return cacheRoot;
}
