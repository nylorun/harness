/**
 * // CLIENTS-CCR: owned by WS-F1 — `nylorun runtime …` dispatch target.
 * Signature matches F1: `runtimeCommand(args, options?)` with `envHook` for `--env`.
 */
import { CliError } from "../errors.js";

export const runtimeUsage = `  runtime up [--port <n>] [--version <v>]
  runtime down [--wait] [--force] [--timeout <seconds>]
  runtime status [--json] [--env]
  runtime logs [-f|--follow] [-n <lines>] [--tenant <id>|--all]
  runtime restart [--port <n>] [--version <v>] [--allow-downgrade] [--wait|--force]
  runtime run [--port <n>] [--version <v>]
  up                       alias for "runtime up"
  down                     alias for "runtime down"
  logs                     alias for "runtime logs"`;

export interface RuntimeCommandOptions {
  home?: string;
  envHook?: () => void | Promise<void>;
}

/** Placeholder until F1 implements launcher-backed runtime commands. */
export async function runtimeCommand(
  args: readonly string[],
  options: RuntimeCommandOptions = {},
): Promise<void> {
  const [verb, ...rest] = args;
  if (!verb || verb === "--help" || verb === "-h") {
    console.log(runtimeUsage);
    return;
  }
  if (verb === "status" && rest.includes("--env") && options.envHook) {
    await options.envHook();
    return;
  }
  throw new CliError(
    // CLIENTS-CCR: awaiting WS-F1 cli/src/runtime/commands.ts
    `nylorun runtime ${verb} is not available yet (awaiting WS-F1).\n${runtimeUsage}`,
    1,
  );
}
