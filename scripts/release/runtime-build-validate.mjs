/**
 * G6: validate Runtime build manifests, warn on size, and dry-run npm view
 * resolution for the five platform packages (D8 / D17).
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  RUNTIME_BUILD_PLATFORMS,
  buildPackageName,
  currentPlatformArch,
  localRuntimeBuild,
  materializeNodeBinary,
} from "../lib/local-build.mjs";
import { npm, readJson, root } from "../lib/repo.mjs";

export const BUILD_SIZE_WARN_BYTES = 60 * 1024 * 1024;

export function buildPackageNames() {
  return RUNTIME_BUILD_PLATFORMS.map((key) => {
    const [platform, arch] = key.split("-");
    return { key, platform, arch, name: buildPackageName(platform, arch) };
  });
}

/**
 * Publication order for Runtime builds (D17): after @nylorun/runtime,
 * before @nylorun/cli — same platform list as D8.
 */
export function runtimeBuildPublishOrder() {
  return buildPackageNames().map((entry) => entry.name);
}

async function directorySizeBytes(dir) {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySizeBytes(path);
    else if (entry.isFile() || entry.isSymbolicLink()) {
      const info = await stat(path).catch(() => null);
      if (info) total += info.size;
    }
  }
  return total;
}

/**
 * Validate a D§8.2 build directory's package.json + manifest.json.
 * @returns {{ name: string, version: string, size: number, warnings: string[] }}
 */
export async function validateBuildDirectory(dir) {
  const warnings = [];
  const pkg = await readJson(join(dir, "package.json"));
  const manifest = await readJson(join(dir, "manifest.json"));
  if (typeof pkg.name !== "string" || !pkg.name.startsWith("@nylorun/runtime-"))
    throw new Error(`Build package.json name is invalid: ${pkg.name}`);
  if (typeof pkg.version !== "string" || !pkg.version)
    throw new Error(`Build package.json version is missing in ${dir}`);
  if (manifest.format !== 1)
    throw new Error(`Build manifest.format must be 1 (got ${manifest.format}).`);
  if (manifest.runtimeVersion !== pkg.version)
    throw new Error(
      `manifest.runtimeVersion (${manifest.runtimeVersion}) must equal package version (${pkg.version}).`,
    );
  for (const field of [
    "platform",
    "arch",
    "entry",
    "launcher",
    "launcherProtocol",
    "protocol",
    "tenantSchema",
    "node",
  ]) {
    if (manifest[field] == null)
      throw new Error(`Build manifest missing required field: ${field}`);
  }
  if (!manifest.node?.version)
    throw new Error("Build manifest.node.version is required.");
  if (pkg.publishConfig?.provenance !== true)
    throw new Error(`${pkg.name} must declare publishConfig.provenance: true.`);

  const size = await directorySizeBytes(dir);
  if (size > BUILD_SIZE_WARN_BYTES) {
    const mb = (size / (1024 * 1024)).toFixed(1);
    warnings.push(
      `${pkg.name}@${pkg.version} is ${mb} MB (warn above 60 MB); consider splitting Node into @nylorun/node-* packages.`,
    );
  }
  return { name: pkg.name, version: pkg.version, size, warnings, manifest };
}

/**
 * Dry-run: for each platform package, attempt `npm view` of the pinned
 * runtime version. Missing packages (E404) are OK before first publish;
 * other failures abort. Does not publish.
 */
export async function dryRunPinnedBuildResolve(runtimeVersion) {
  const results = [];
  for (const { name, key } of buildPackageNames()) {
    const spec = `${name}@${runtimeVersion}`;
    try {
      const version = JSON.parse(
        await npm(["view", spec, "version", "--json"], { capture: true }),
      );
      results.push({ name, key, status: "resolves", version });
    } catch (error) {
      let response;
      try {
        response = JSON.parse(error.stdout ?? "");
      } catch {
        /* ignore */
      }
      if (response?.error?.code === "E404") {
        results.push({ name, key, status: "unpublished", version: runtimeVersion });
        continue;
      }
      throw new Error(
        `npm view dry-run failed for ${spec}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  return results;
}

/**
 * Build the current platform locally (if needed), validate it, and dry-run
 * npm view for all five platform packages at the runtime pin.
 */
export async function checkRuntimeBuilds({
  repo = root,
  out,
  log = console.log,
} = {}) {
  const runtime = await readJson(join(repo, "runtime/package.json"));
  const version = runtime.version;
  const { platform, arch } = currentPlatformArch();
  const built = await localRuntimeBuild({ out, repo });
  await materializeNodeBinary(built.dir, platform);
  const validated = await validateBuildDirectory(built.dir);
  for (const warning of validated.warnings) log(`warning: ${warning}`);
  if (validated.name !== buildPackageName(platform, arch))
    throw new Error(
      `Local build name ${validated.name} does not match ${platform}-${arch}.`,
    );
  if (validated.version !== version)
    throw new Error(
      `Local build version ${validated.version} does not match runtime ${version}.`,
    );
  const views = await dryRunPinnedBuildResolve(version);
  const published = views.filter((entry) => entry.status === "resolves").length;
  log(
    `Runtime builds check: local ${validated.name}@${validated.version} ok (${(validated.size / (1024 * 1024)).toFixed(1)} MB); npm view dry-run ${published}/${views.length} already on registry.`,
  );
  return { built, validated, views };
}
