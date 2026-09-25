/**
 * CI helper for publish.yml runtime-build matrix: run --release, copy the
 * tarball into .tmp/release-artifacts/runtime-builds/, write builds-<platform>.json.
 *
 * Env: PLATFORM=darwin-arm64|linux-x64|linux-arm64|win32-x64
 */
import { mkdir, copyFile, writeFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { integrity } from "./artifacts.mjs";
import { buildRelease } from "./runtime-builds.mjs";
import {
  buildPackageName,
  currentPlatformArch,
} from "../lib/local-build.mjs";
import { readJson, root } from "../lib/repo.mjs";

const platformKey = process.env.PLATFORM;
if (!platformKey)
  throw new Error("PLATFORM env is required (e.g. linux-x64).");

const [platform, arch] = platformKey.split("-");
const current = currentPlatformArch();
if (current.key !== platformKey)
  throw new Error(
    `Runner platform ${current.key} does not match matrix PLATFORM=${platformKey}.`,
  );

const result = await buildRelease();
const packDir = join(root, ".tmp/runtime-builds");
const tarballs = (await readdir(packDir)).filter((name) =>
  name.endsWith(".tgz"),
);
if (tarballs.length === 0)
  throw new Error(`No Runtime build tarball found under ${packDir}.`);
// Prefer the tarball matching this package name when several exist.
const name = buildPackageName(platform, arch);
const preferred =
  tarballs.find((file) => file.includes(name.replace("@", "").replace("/", "-"))) ??
  tarballs.find((file) => file.includes(`runtime-${platform}-${arch}`)) ??
  tarballs[0];
const source = result.tarball ?? join(packDir, preferred);
const outDir = join(root, ".tmp/release-artifacts/runtime-builds");
await mkdir(outDir, { recursive: true });
const file = basename(source);
const destination = join(outDir, file);
await copyFile(source, destination);
const runtime = await readJson(join(root, "runtime/package.json"));
const hash = await integrity(destination);
const shard = {
  runtimeVersion: runtime.version,
  builds: {
    [name]: {
      version: runtime.version,
      file,
      integrity: hash,
    },
  },
};
await writeFile(
  join(outDir, `builds-${platformKey}.json`),
  JSON.stringify(shard, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    { platform: platformKey, name, version: runtime.version, file },
    null,
    2,
  ),
);
