#!/usr/bin/env node
/**
 * Launcher process entry: the `nylorun-runtime` bin of `@nylorun/runtime`.
 *
 * The only file under runtime/src/launcher/ allowed to read ambient process/OS
 * state (process.env, process.cwd(), os.homedir(), os.tmpdir()). Values are
 * resolved here and passed down explicitly.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { runLauncher } from "./commands.js";

function resolveHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.NYLORUN_HOME;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return resolve(fromEnv);
  return resolve(homedir(), ".nylorun");
}

/** Copy allowlisted ambient keys for Host spawn (Tenants §12). */
function baselineFromEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    if (key === "PATH" || key === "LANG" || key === "TZ" || key.startsWith("LC_")) {
      out[key] = env[key];
    }
  }
  // Release/dev smokes set NYLORUN_DEV_MODEL=fixture; pass through so the Host
  // can open Tenants with the credential-free fixture provider.
  const devModel = env.NYLORUN_DEV_MODEL?.trim();
  if (devModel) out.NYLORUN_DEV_MODEL = devModel;
  return out;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  return runLauncher(argv, {
    home: resolveHome(env),
    platform: process.platform,
    // The Host runs on the same Node as the launcher; no Node is bundled.
    nodeBinary: process.execPath,
    nodeVersion: process.versions.node,
    baselineEnv: baselineFromEnv(env),
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
// npm installs link `bin/nylorun-runtime` to this file.
const isEntry =
  entry !== undefined &&
  (entry.endsWith("launcher/main.ts") ||
    entry.endsWith("launcher/main.js") ||
    entry.endsWith("nylorun-runtime"));

if (isEntry) {
  main().then((code) => {
    process.exitCode = code;
  });
}
