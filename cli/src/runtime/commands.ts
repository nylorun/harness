/**
 * // CLIENTS-CCR: owned by WS-F1 — `nylorun runtime …` dispatch target.
 * F2 wires a one-line call from cli.ts; F1 replaces this stub.
 */
import { CliError } from "../errors.js";

export const runtimeUsage = `  runtime up [--port <n>]
  runtime down [--wait] [--force] [--timeout <seconds>]
  runtime status [--json] [--env]
  runtime logs [-f|--follow] [-n <lines>] [--tenant <id>|--all]
  runtime restart [--port <n>] [--version <v>] [--allow-downgrade] [--wait|--force]
  runtime run [--port <n>]
  up                       alias for "runtime up"
  down                     alias for "runtime down"
  logs                     alias for "runtime logs"`;

/** Placeholder until F1 implements launcher-backed runtime commands. */
export async function runtimeCommand(args: readonly string[]): Promise<void> {
  const [verb] = args;
  if (!verb || verb === "--help" || verb === "-h") {
    console.log(runtimeUsage);
    return;
  }
  throw new CliError(
    // CLIENTS-CCR: awaiting WS-F1 cli/src/runtime/commands.ts
    `nylorun runtime ${verb} is not available yet (awaiting WS-F1).\n${runtimeUsage}`,
    1,
  );
}
