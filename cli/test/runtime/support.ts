/**
 * Test helpers for CLI runtime tests.
 * Installs a Runtime the way `npm install --global @nylorun/runtime` does: a
 * `nylorun-runtime` bin on PATH whose launcher is the workspace launcher,
 * started against a Host stub, without importing `@nylorun/runtime` from CLI
 * source.
 */
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeFakeHost } from "../../../runtime/test/launcher/fixtures/fake-host.js";
import {
  removeRoot,
  temporaryRoot,
} from "../../../runtime/test/launcher/fixtures/roots.js";

export { removeRoot, temporaryRoot };

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

export interface TestRuntime {
  /** `nylorun-runtime` on PATH. */
  bin: string;
  /** process.env with the install's bin directory first on PATH. */
  env: NodeJS.ProcessEnv;
}

/**
 * Lay out a global npm install of Runtime `version` under `prefix`.
 * `main` replaces the launcher script (for incompatible-launcher tests).
 */
export async function installTestRuntime(
  prefix: string,
  version: string,
  options: { main?: string } = {},
): Promise<TestRuntime> {
  const packageDir = join(prefix, "lib", "node_modules", "@nylorun", "runtime");
  const launcherDir = join(packageDir, "dist", "launcher");
  await mkdir(launcherDir, { recursive: true });
  await writeFile(
    join(packageDir, "package.json"),
    JSON.stringify({ name: "@nylorun/runtime", version, type: "module" }),
  );
  const hostEntry = await writeFakeHost(join(packageDir, "dist", "host"), {
    version,
  });
  const commandsUrl = pathToFileURL(
    join(repoRoot, "runtime/dist/launcher/commands.js"),
  ).href;
  const main = join(launcherDir, "main.js");
  await writeFile(
    main,
    options.main ??
      `#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { runLauncher } from ${JSON.stringify(commandsUrl)};
const env = process.env;
const code = await runLauncher(process.argv.slice(2), {
  home: env.NYLORUN_HOME || join(homedir(), ".nylorun"),
  platform: process.platform,
  nodeBinary: process.execPath,
  nodeVersion: process.versions.node,
  baselineEnv: { PATH: env.PATH },
  sink: {
    json: false,
    stdout: (line) => process.stdout.write(line + "\\n"),
    stderr: (line) => process.stderr.write(line + "\\n"),
  },
  lifecycle: {
    hostEntry: ${JSON.stringify(hostEntry)},
    runtimeVersion: ${JSON.stringify(version)},
  },
});
process.exit(code);
`,
    { mode: 0o755 },
  );

  const binDir = join(prefix, "bin");
  await mkdir(binDir, { recursive: true });
  const bin = join(binDir, "nylorun-runtime");
  await symlink(main, bin);
  return {
    bin,
    env: {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}
