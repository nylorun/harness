/**
 * Launcher process entry (`dist/launcher/main.js` inside a Runtime build).
 *
 * The only file under runtime/src/launcher/ allowed to read ambient process/OS
 * state (process.env, process.cwd(), os.homedir(), os.tmpdir()). Values are
 * resolved here and passed down explicitly.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { PlatformArch } from "./builds.js";
import { runLauncher } from "./commands.js";

function resolveHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.NYLORUN_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return resolve(fromEnv);
  return resolve(homedir(), ".nylorun");
}

function resolveRegistry(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.NYLORUN_REGISTRY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return fromEnv.trim();
  return "https://registry.npmjs.org";
}

function currentPlatform(): PlatformArch["platform"] {
  const value = process.platform;
  if (value === "darwin" || value === "linux" || value === "win32") return value;
  return value as PlatformArch["platform"];
}

function currentArch(): PlatformArch["arch"] {
  const value = process.arch;
  if (value === "arm64" || value === "x64") return value;
  return value as PlatformArch["arch"];
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return runLauncher(argv, {
    home: resolveHome(env),
    registry: resolveRegistry(env),
    platform: currentPlatform(),
    arch: currentArch(),
    sink: {
      json: false,
      stdout: (line) => {
        process.stdout.write(`${line}\n`);
      },
      stderr: (line) => {
        process.stderr.write(`${line}\n`);
      },
    },
  });
}

const entry = process.argv[1];
const isEntry =
  entry !== undefined &&
  (entry.endsWith("launcher/main.ts") ||
    entry.endsWith("launcher/main.js") ||
    entry.endsWith("nylorun-runtime") ||
    entry.endsWith("nylorun-runtime.cmd"));

if (isEntry) {
  main().then((code) => {
    process.exitCode = code;
  });
}
