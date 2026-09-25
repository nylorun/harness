/**
 * Build studio/dist/hosting-site for Firebase Hosting (design §9 / I12).
 *
 * Layout:
 *   /index.html          ← latest entry (mutable, no-store)
 *   /versions.json       ← { latest, protocols } (mutable, no-store)
 *   /v/<version>/…       ← immutable build (dist/web + bundle.tar)
 *
 * Preserves prior /v/* by copying from an optional mirror directory and/or
 * fetching from the live HOSTED_ORIGIN when reachable. Refuses to overwrite
 * an existing /v/<version>/ (I12).
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const studioRoot = fileURLToPath(new URL("..", import.meta.url));
const HOSTED_ORIGIN = "https://local.nylorun.studio";

function usage() {
  console.error(
    "Usage: node studio/scripts/prepare-hosting-site.mjs --version <v> [--web <dir>] [--bundle <tar>] [--mirror <dir>] [--origin <url>] [--out <dir>]",
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    version: undefined,
    web: join(studioRoot, "dist/web"),
    bundle: join(studioRoot, "dist/bundle.tar"),
    mirror: undefined,
    origin: HOSTED_ORIGIN,
    outDir: join(studioRoot, "dist/hosting-site"),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if (a === "--version" && next) {
      out.version = next;
      i++;
    } else if (a === "--web" && next) {
      out.web = next;
      i++;
    } else if (a === "--bundle" && next) {
      out.bundle = next;
      i++;
    } else if (a === "--mirror" && next) {
      out.mirror = next;
      i++;
    } else if (a === "--origin" && next) {
      out.origin = next.replace(/\/$/, "");
      i++;
    } else if (a === "--out" && next) {
      out.outDir = next;
      i++;
    } else usage();
  }
  if (!out.version) usage();
  return out;
}

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function copyTree(src, dest) {
  ensureDir(dirname(dest));
  cpSync(src, dest, { recursive: true });
}

async function fetchText(url) {
  try {
    const response = await fetch(url, { redirect: "error" });
    if (!response.ok) return undefined;
    return response.text();
  } catch {
    return undefined;
  }
}

async function fetchJson(url) {
  const text = await fetchText(url);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function downloadFile(url, dest) {
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(`GET ${url} → ${response.status}`);
  }
  const buf = Buffer.from(await response.arrayBuffer());
  ensureDir(dirname(dest));
  writeFileSync(dest, buf);
}

/** Collect href="/v/version/..." asset paths from an index.html. */
function assetPathsFromIndex(html, version) {
  const prefix = `/v/${version}/`;
  const paths = new Set([`${prefix}index.html`, `${prefix}bundle.tar`]);
  const re = /(?:src|href)=["'](\/v\/[^"']+)["']/g;
  let match;
  while ((match = re.exec(html))) {
    paths.add(match[1].split("?")[0]);
  }
  return [...paths];
}

async function pullLiveVersion(origin, version, siteRoot) {
  const indexUrl = `${origin}/v/${version}/index.html`;
  const html = await fetchText(indexUrl);
  if (html === undefined) {
    console.warn(`warn: could not fetch ${indexUrl}; skipping prior version`);
    return;
  }
  const destRoot = join(siteRoot, "v", version);
  ensureDir(destRoot);
  for (const path of assetPathsFromIndex(html, version)) {
    const url = `${origin}${path}`;
    const dest = join(siteRoot, path.replace(/^\//, ""));
    try {
      await downloadFile(url, dest);
    } catch (error) {
      console.warn(
        `warn: ${url}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

function readDigest(studioRootDir) {
  const path = join(studioRootDir, "dist/ui-digest.json");
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}; run pack-ui first.`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export async function prepareHostingSite(options) {
  const {
    version,
    web,
    bundle,
    mirror,
    origin,
    outDir,
  } = options;

  if (!existsSync(web) || !existsSync(join(web, "index.html"))) {
    throw new Error(`Web build missing at ${web}`);
  }
  if (!existsSync(bundle)) {
    throw new Error(`Bundle missing at ${bundle}`);
  }

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
  ensureDir(outDir);

  // Preserve prior immutable versions from a local mirror (CI cache / prior job).
  if (mirror && existsSync(mirror)) {
    const mirrorV = join(mirror, "v");
    if (existsSync(mirrorV)) {
      copyTree(mirrorV, join(outDir, "v"));
    }
    const mirrorVersions = join(mirror, "versions.json");
    if (existsSync(mirrorVersions)) {
      writeFileSync(
        join(outDir, "versions.json"),
        readFileSync(mirrorVersions),
      );
    }
  }

  // Merge versions still live on the hosted origin (if DNS/SSL already up).
  const live = await fetchJson(`${origin}/versions.json`);
  if (live && typeof live === "object" && live.protocols) {
    const prior = new Set([
      live.latest,
      ...Object.values(live.protocols),
    ].filter((v) => typeof v === "string" && v.length > 0));
    for (const priorVersion of prior) {
      if (priorVersion === version) continue;
      if (existsSync(join(outDir, "v", priorVersion, "index.html"))) continue;
      await pullLiveVersion(origin, priorVersion, outDir);
    }
    if (!existsSync(join(outDir, "versions.json"))) {
      writeFileSync(
        join(outDir, "versions.json"),
        `${JSON.stringify(live, null, 2)}\n`,
      );
    }
  }

  const versionDir = join(outDir, "v", version);
  if (existsSync(join(versionDir, "index.html"))) {
    throw new Error(
      `Refusing to overwrite immutable /v/${version}/ (I12). Pick a new Studio version.`,
    );
  }

  copyTree(web, versionDir);
  writeFileSync(join(versionDir, "bundle.tar"), readFileSync(bundle));

  // Root entry = this build's index (asset base /v/<version>/).
  writeFileSync(
    join(outDir, "index.html"),
    readFileSync(join(versionDir, "index.html")),
  );

  const digest = readDigest(studioRoot);
  const protocols = { "1": version };
  if (live?.protocols && typeof live.protocols === "object") {
    Object.assign(protocols, live.protocols);
  }
  protocols["1"] = version; // protocol 1 → newest
  const manifest = {
    latest: version,
    protocols,
  };
  writeFileSync(
    join(outDir, "versions.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  // Carry digest for verify step.
  writeFileSync(
    join(outDir, "ui-digest.json"),
    `${JSON.stringify({ version: digest.version, sha256: digest.sha256 }, null, 2)}\n`,
  );

  return { outDir, version, manifest, sha256: digest.sha256 };
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const result = await prepareHostingSite(args);
  console.log(
    `Prepared hosting site at ${result.outDir} (v/${result.version}, sha256 ${result.sha256.slice(0, 12)}…).`,
  );
}
