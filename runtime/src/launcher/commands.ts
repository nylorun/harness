import { resolve } from "node:path";
import type { PlatformArch } from "./builds.js";
import { LauncherError, UsageError } from "./errors.js";
import { install } from "./install.js";
import { logs } from "./logs.js";
import { emitError, emitEvent, emitResult, exitCodeFor, type OutputSink } from "./output.js";
import { ensureHostLayout, hostPaths } from "./paths.js";
import { status } from "./status.js";

export const launcherUsage = `Usage: nylorun-runtime [--home <dir>] [--json] <command>

Commands:
  install <version> [--from <dir>]
  status
  logs [--lines <n>] [--follow] [--tenant <id> | --all]

Lifecycle commands (up, down, restart, run) land in a later release.`;

export interface LauncherRuntimeOptions {
  home: string;
  registry: string;
  platform: PlatformArch["platform"];
  arch: PlatformArch["arch"];
  sink: OutputSink;
  fetchImpl?: typeof fetch;
  /** Abort signal for logs --follow (tests). */
  signal?: AbortSignal;
}

interface Flags {
  rest: string[];
  booleans: Set<string>;
  values: Map<string, string>;
  json: boolean;
  home?: string;
}

function usage(message: string): never {
  throw new UsageError(`${message}\n\n${launcherUsage}`);
}

function parseGlobal(args: readonly string[]): Flags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  let json = false;
  let home: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--home") {
      const value = args[++index];
      if (!value || value.startsWith("-")) usage("--home requires a directory.");
      home = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new UsageError(launcherUsage, "");
    }
    rest.push(arg);
  }
  return { rest, booleans, values, json, home };
}

function parseCommandFlags(
  args: readonly string[],
  allowed: { booleans?: readonly string[]; values?: readonly string[] } = {},
): Flags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  const booleanNames = new Set(allowed.booleans ?? []);
  const valueNames = new Set(allowed.values ?? []);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) {
      rest.push(arg);
      continue;
    }
    if (booleanNames.has(arg)) {
      if (booleans.has(arg)) usage(`${arg} may only be supplied once.`);
      booleans.add(arg);
      continue;
    }
    if (valueNames.has(arg)) {
      if (values.has(arg)) usage(`${arg} may only be supplied once.`);
      const value = args[++index];
      if (!value || value.startsWith("-")) usage(`${arg} requires a value.`);
      values.set(arg, value);
      continue;
    }
    usage(`Unknown flag ${arg}.`);
  }
  return { rest, booleans, values, json: false };
}

/**
 * Run launcher commands. Returns a process exit code (0, 1, or 2).
 * Ambient values must already be resolved into `options`.
 */
export async function runLauncher(
  argv: readonly string[],
  options: LauncherRuntimeOptions,
): Promise<number> {
  const sink = options.sink;
  try {
    const global = parseGlobal(argv);
    sink.json = global.json || sink.json;
    const home = resolve(global.home ?? options.home);
    const paths = hostPaths(home);
    const [verb, ...rest] = global.rest;
    if (!verb) usage("Missing command.");

    if (verb === "install") {
      const flags = parseCommandFlags(rest, { values: ["--from"] });
      const version = flags.rest[0];
      if (!version || flags.rest.length !== 1) {
        usage("install requires exactly one <version>.");
      }
      await ensureHostLayout(paths);
      const result = await install(paths, {
        version,
        registry: options.registry,
        platform: options.platform,
        arch: options.arch,
        ...(flags.values.has("--from")
          ? { from: resolve(flags.values.get("--from")!) }
          : {}),
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        emit: (event) => emitEvent(sink, event),
      });
      emitResult(sink, { ...result });
      return 0;
    }

    if (verb === "status") {
      const flags = parseCommandFlags(rest);
      if (flags.rest.length) usage("status takes no arguments.");
      const result = await status(paths, {
        platform: options.platform,
        arch: options.arch,
      });
      emitResult(sink, { ...result });
      return 0;
    }

    if (verb === "logs") {
      const flags = parseCommandFlags(rest, {
        booleans: ["--follow", "-f", "--all"],
        values: ["--lines", "-n", "--tenant"],
      });
      if (flags.rest.length) usage("logs takes no positional arguments.");
      if (flags.booleans.has("--all") && flags.values.has("--tenant")) {
        usage("Use either --tenant or --all, not both.");
      }
      const linesRaw =
        flags.values.get("--lines") ?? flags.values.get("-n");
      let lines: number | undefined;
      if (linesRaw !== undefined) {
        lines = Number(linesRaw);
        if (!Number.isInteger(lines) || lines < 0) {
          usage("--lines must be a non-negative integer.");
        }
      }
      await logs(paths, {
        ...(lines !== undefined ? { lines } : {}),
        follow: flags.booleans.has("--follow") || flags.booleans.has("-f"),
        all: flags.booleans.has("--all"),
        ...(flags.values.has("--tenant")
          ? { tenant: flags.values.get("--tenant") }
          : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        emit: (event) => emitEvent(sink, event),
      });
      return 0;
    }

    if (
      verb === "up" ||
      verb === "down" ||
      verb === "restart" ||
      verb === "run"
    ) {
      throw new LauncherError(
        "install_failed",
        `Command "${verb}" is not available in this launcher build yet.`,
        "Upgrade to a Runtime build that includes lifecycle commands.",
      );
    }

    usage(`Unknown command ${verb}.`);
  } catch (error) {
    emitError(sink, error instanceof Error ? error : new Error(String(error)));
    return exitCodeFor(error);
  }
}
