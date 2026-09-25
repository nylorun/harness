/**
 * Deploy Studio UI to Firebase Hosting and verify CSP + bundle digest.
 *
 * Env:
 *   FIREBASE_PROJECT_ID   — default from .firebaserc / nylorun-oss-studio
 *   FIREBASE_TOKEN        — optional CI token (alternative to GOOGLE_APPLICATION_CREDENTIALS)
 *   GOOGLE_APPLICATION_CREDENTIALS — path to SA JSON (preferred)
 *   STUDIO_HOSTING_ORIGIN — default https://local.nylorun.studio
 *   STUDIO_SKIP_DEPLOY=1  — prepare + dry-run verify only (no firebase CLI)
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHostingSite } from "./prepare-hosting-site.mjs";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const studioRoot = fileURLToPath(new URL("..", import.meta.url));
const HOSTED_ORIGIN = "https://local.nylorun.studio";

function readPackageVersion() {
  return JSON.parse(readFileSync(join(studioRoot, "package.json"), "utf8"))
    .version;
}

function sha256Buffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function verifyLive(origin, version, expectedSha256) {
  const head = await fetch(`${origin}/`, { method: "HEAD", redirect: "error" });
  if (!head.ok) {
    throw new Error(`HEAD ${origin}/ → ${head.status}`);
  }
  const csp = head.headers.get("content-security-policy") ?? "";
  if (!csp.includes("default-src 'none'") || !csp.includes("script-src 'self'")) {
    throw new Error(`CSP missing expected directives: ${csp}`);
  }
  const bundleRes = await fetch(`${origin}/v/${version}/bundle.tar`, {
    redirect: "error",
  });
  if (!bundleRes.ok) {
    throw new Error(`GET bundle.tar → ${bundleRes.status}`);
  }
  const actual = sha256Buffer(Buffer.from(await bundleRes.arrayBuffer()));
  if (actual !== expectedSha256.toLowerCase()) {
    throw new Error(
      `bundle.tar digest mismatch: expected ${expectedSha256}, got ${actual}`,
    );
  }
  console.log(`Verified ${origin} CSP + /v/${version}/bundle.tar digest.`);
}

function runFirebaseDeploy(projectId) {
  const args = [
    "firebase-tools@13",
    "deploy",
    "--only",
    "hosting",
    "--project",
    projectId,
    "--non-interactive",
  ];
  const env = { ...process.env };
  console.log(`Running: npx ${args.join(" ")}`);
  const result = spawnSync("npx", args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`firebase deploy exited ${result.status}`);
  }
}

const version = process.env.STUDIO_VERSION || readPackageVersion();
const origin = (process.env.STUDIO_HOSTING_ORIGIN || HOSTED_ORIGIN).replace(
  /\/$/,
  "",
);
const projectId =
  process.env.FIREBASE_PROJECT_ID ||
  JSON.parse(readFileSync(join(repoRoot, ".firebaserc"), "utf8")).projects
    .default;

const prepared = await prepareHostingSite({
  version,
  web: join(studioRoot, "dist/web"),
  bundle: join(studioRoot, "dist/bundle.tar"),
  mirror: process.env.STUDIO_HOSTING_MIRROR,
  origin,
  outDir: join(studioRoot, "dist/hosting-site"),
});

if (process.env.STUDIO_SKIP_DEPLOY === "1") {
  console.log(
    `Prepared ${prepared.outDir}; STUDIO_SKIP_DEPLOY=1 — skipping firebase deploy.`,
  );
  process.exit(0);
}

const hasSa = Boolean(process.env.GOOGLE_APPLICATION_CREDENTIALS);
const hasToken = Boolean(process.env.FIREBASE_TOKEN);
if (!hasSa && !hasToken) {
  console.error(
    "Missing Firebase credentials. Set GOOGLE_APPLICATION_CREDENTIALS (preferred) or FIREBASE_TOKEN.\n" +
      "See docs/hosted-studio-firebase-handoff.md. Exiting without deploy.",
  );
  process.exit(78); // EX_CONFIG — soft pause for human secrets
}

runFirebaseDeploy(projectId);

// Custom domain may still be pending; try verify against configured origin,
// then fall back to the Firebase web.app host.
try {
  await verifyLive(origin, version, prepared.sha256);
} catch (error) {
  const fallback = `https://${projectId}.web.app`;
  console.warn(
    `Verify against ${origin} failed (${error instanceof Error ? error.message : error}); trying ${fallback}`,
  );
  await verifyLive(fallback, version, prepared.sha256);
  console.warn(
    `Deployed to ${fallback}. Custom domain ${origin} still needs DNS/SSL (Rahul handoff §2).`,
  );
}
