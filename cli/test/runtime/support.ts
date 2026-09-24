/**
 * Test helpers for CLI runtime tests.
 * Uses WS-E launcher fixtures; wires the workspace launcher into fake builds
 * so bootstrap / invoke exercise the real launcher without importing
 * `@nylorun/runtime` from CLI source.
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  writeFakeBuild,
  type FakeBuildOptions,
} from "../../../runtime/test/launcher/fixtures/fake-build.js";
import {
  currentPlatformArch,
  packFakeBuildTarball,
  removeRoot,
  startFakeRegistry,
  temporaryRoot,
} from "../../../runtime/test/launcher/fixtures/registry.js";

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export {
  currentPlatformArch,
  packFakeBuildTarball,
  removeRoot,
  startFakeRegistry,
  temporaryRoot,
  writeFakeBuild,
};

/** Absolute path to the workspace-compiled launcher entry. */
export function workspaceLauncherMain(): string {
  return join(repoRoot, "runtime/dist/launcher/main.js");
}

/**
 * Write a fake build whose launcher.js delegates to the workspace launcher.
 */
export async function writeCliTestBuild(
  dir: string,
  options: FakeBuildOptions,
): Promise<Awaited<ReturnType<typeof writeFakeBuild>>> {
  const build = await writeFakeBuild(dir, options);
  const launcherUrl = pathToFileURL(workspaceLauncherMain()).href;
  await writeFile(
    build.launcher,
    `import { main } from ${JSON.stringify(launcherUrl)};
const code = await main(process.argv.slice(2));
process.exit(code);
`,
  );
  return build;
}

export async function startRegistryWithCliBuild(version: string): Promise<{
  url: string;
  close: () => Promise<void>;
  buildDir: string;
  roots: string[];
}> {
  const roots: string[] = [];
  const buildDir = await temporaryRoot("nylorun-cli-build-");
  roots.push(buildDir);
  await writeCliTestBuild(buildDir, {
    version,
    ...currentPlatformArch(),
  });
  const registry = await startFakeRegistry({ version, buildDir });
  return {
    url: registry.url,
    buildDir,
    roots,
    close: async () => {
      await registry.close();
      await Promise.all(roots.map(removeRoot));
    },
  };
}
