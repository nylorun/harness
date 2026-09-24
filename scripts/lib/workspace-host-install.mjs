/**
 * Seed `NYLORUN_HOME/runtime/<version>/` from workspace-packed core, harness,
 * and runtime. Registry `@nylorun/runtime@0.9.0-beta` still points `./server` at
 * the pre-Tenant entry; smokes and local Host installs must use packed sources.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { npm, readJson, root } from "./repo.mjs";

export async function packWorkspacePackages(destination, names) {
  await mkdir(destination, { recursive: true });
  const packed = {};
  for (const name of names) {
    const result = JSON.parse(
      await npm(
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          destination,
        ],
        { cwd: join(root, name), capture: true },
      ),
    );
    packed[name] = join(destination, result[0].filename);
  }
  return packed;
}

/**
 * Install a verified Host runtime tree under `hostRoot/runtime/<version>/`.
 * When present, `ensureInstalled` reuses it instead of hitting the registry.
 */
export async function seedWorkspaceHostInstall(hostRoot, version) {
  const packed = await packWorkspacePackages(join(hostRoot, ".pack"), [
    "core",
    "harness",
    "runtime",
  ]);
  const target = join(hostRoot, "runtime", version);
  const staging = join(
    hostRoot,
    "runtime",
    `.tmp-${version}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(staging, { recursive: true });
  await writeFile(
    join(staging, "package.json"),
    JSON.stringify({
      name: `nylorun-runtime-install-${version}`,
      private: true,
      dependencies: {
        "@nylorun/core": version,
        "@nylorun/harness": version,
        "@nylorun/runtime": version,
      },
    }),
  );
  await npm(
    [
      "install",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      packed.core,
      packed.harness,
      packed.runtime,
    ],
    { cwd: staging, capture: true },
  );
  const pkgPath = join(staging, "node_modules/@nylorun/runtime/package.json");
  const pkg = await readJson(pkgPath);
  if (pkg.version !== version) {
    pkg.version = version;
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
  }
  await rename(staging, target);
  return target;
}

export function workspaceRuntimeVersion() {
  return readJson(join(root, "runtime/package.json")).then((pkg) => pkg.version);
}
