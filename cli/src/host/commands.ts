import { CliError } from "../errors.js";
import {
  down,
  logsCommand,
  printStatus,
  restart,
  run,
  statusCommand,
  up,
} from "./lifecycle.js";

export const runtimeUsage = `  runtime up [--port <n>] [--foreground]
  runtime down [--wait] [--force] [--timeout <seconds>]
  runtime status [--json] [--env]
  runtime logs [-f|--follow] [-n <lines>]
  runtime restart [--port <n>]
  runtime run [--port <n>]
  up                       alias for "runtime up"
  down                     alias for "runtime down"
  logs                     alias for "runtime logs"`;

const usageError = (message: string) => new CliError(message, 2);

interface Flags {
  rest: string[];
  booleans: Set<string>;
  values: Map<string, string>;
}

function parseRuntimeFlags(
  args: readonly string[],
  allowed: { booleans?: readonly string[]; values?: readonly string[] } = {},
): Flags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  const booleanNames = new Set(allowed.booleans ?? []);
  const valueNames = new Set(["--port", ...(allowed.values ?? [])]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) {
      rest.push(arg);
      continue;
    }
    if (booleanNames.has(arg)) {
      if (booleans.has(arg)) throw usageError(`${arg} may only be supplied once.`);
      booleans.add(arg);
      continue;
    }
    if (valueNames.has(arg)) {
      if (values.has(arg)) throw usageError(`${arg} may only be supplied once.`);
      const value = args[++index];
      if (!value || value.startsWith("-"))
        throw usageError(`${arg} requires a value.`);
      values.set(arg, value);
      continue;
    }
    throw usageError(`Unknown flag ${arg}.\n${runtimeUsage}`);
  }
  return { rest, booleans, values };
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw usageError("--port must be an integer between 1 and 65535.");
  return port;
}

/**
 * `nylorun runtime …` and the `up` / `down` / `logs` aliases.
 * Owned by WS-E; WS-F owns the rest of `cli.ts`.
 */
export async function runtimeCommand(args: readonly string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === "up" || verb === "start") {
    const flags = parseRuntimeFlags(rest, {
      booleans: ["--foreground"],
    });
    if (flags.rest.length) throw usageError(runtimeUsage);
    const port = parsePort(flags.values.get("--port"));
    const before = await up({
      ...(port !== undefined ? { port } : {}),
      foreground: flags.booleans.has("--foreground"),
    });
    if (before.portSelected) {
      console.log(
        `Port 8787 was unavailable; Host listening on ${before.status.url}.`,
      );
    }
    if (before.status.state === "running" && !flags.booleans.has("--foreground")) {
      // up() already short-circuited when already running; still print status.
    }
    printStatus(before.status);
    console.log(`\n→ npx nylorun dev`);
    return;
  }

  if (verb === "down" || verb === "stop") {
    const flags = parseRuntimeFlags(rest, {
      booleans: ["--wait", "--force"],
      values: ["--timeout"],
    });
    if (flags.rest.length) throw usageError(runtimeUsage);
    const seconds = flags.values.has("--timeout")
      ? Number(flags.values.get("--timeout"))
      : undefined;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0))
      throw usageError("--timeout must be a positive number of seconds.");
    const result = await down({
      wait: flags.booleans.has("--wait"),
      force: flags.booleans.has("--force"),
      ...(seconds === undefined ? {} : { timeoutMs: seconds * 1000 }),
    });
    console.log(
      result === "stopped"
        ? `Stopped the Runtime Host. host.json and Tenants are kept under the Host root.`
        : `No Runtime Host is running.`,
    );
    return;
  }

  if (verb === "status") {
    const flags = parseRuntimeFlags(rest, {
      booleans: ["--json", "--env"],
      values: ["--output"],
    });
    if (flags.rest.length) throw usageError(runtimeUsage);
    // Accept legacy --output json for one release.
    const json =
      flags.booleans.has("--json") || flags.values.get("--output") === "json";
    if (
      flags.values.has("--output") &&
      flags.values.get("--output") !== "json" &&
      flags.values.get("--output") !== "text"
    ) {
      throw usageError("--output must be text or json.");
    }
    const status = await statusCommand({
      json,
      env: flags.booleans.has("--env"),
    });
    if (status.state !== "running" && !flags.booleans.has("--env"))
      process.exitCode = status.state === "port-conflict" ? 4 : 3;
    return;
  }

  if (verb === "logs") {
    const flags = parseRuntimeFlags(rest, {
      booleans: ["-f", "--follow"],
      values: ["-n"],
    });
    if (flags.rest.length) throw usageError(runtimeUsage);
    const lines = flags.values.has("-n")
      ? Number(flags.values.get("-n"))
      : 200;
    if (!Number.isInteger(lines) || lines < 1)
      throw usageError("-n must be a positive integer.");
    await logsCommand({
      follow: flags.booleans.has("-f") || flags.booleans.has("--follow"),
      lines,
    });
    return;
  }

  if (verb === "restart") {
    const flags = parseRuntimeFlags(rest);
    if (flags.rest.length) throw usageError(runtimeUsage);
    const port = parsePort(flags.values.get("--port"));
    const result = await restart({
      ...(port !== undefined ? { port } : {}),
    });
    printStatus(result.status);
    return;
  }

  if (verb === "run") {
    const flags = parseRuntimeFlags(rest);
    if (flags.rest.length) throw usageError(runtimeUsage);
    const port = parsePort(flags.values.get("--port"));
    await run({
      ...(port !== undefined ? { port } : {}),
    });
    return;
  }

  throw usageError(runtimeUsage);
}
