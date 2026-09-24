import { resolve } from "node:path";
import type { PlatformArch } from "./builds.js";
import { UsageError } from "./errors.js";
import { install } from "./install.js";
import { down, restart, run, up, type LifecycleContext } from "./lifecycle.js";
import { logs } from "./logs.js";
import {
  emitError,
  emitEvent,
  emitResult,
  exitCodeFor,
  type OutputSink,
} from "./output.js";
import { ensureHostLayout, hostPaths } from "./paths.js";
import { status } from "./status.js";

export const launcherUsage = `Usage: nylorun-runtime [--home <dir>] [--json] <command>

Commands:
  install <version> [--from <dir>]
  up [--version <v>] [--port <n>]
  down [--wait [--timeout <s>]] [--force]
  restart [--version <v>] [--allow-downgrade] [--wait | --force]
  run [--version <v>] [--port <n>]
  status
  logs [--lines <n>] [--follow] [--tenant <id> | --all]`;

export interface LauncherRuntimeOptions {
  home: string;
  registry: string;
  platform: PlatformArch["platform"];
  arch: PlatformArch["arch"];
  sink: OutputSink;
  /** Allowlisted ambient baseline from main.ts. */
  baselineEnv: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  /** Abort signal for logs --follow (tests). */
  signal?: AbortSignal;
  /** Optional lifecycle overrides for tests. */
  lifecycle?: Partial<
    Pick<LifecycleContext, "spawnHost" | "onSignal" | "lock" | "fetchImpl">
  >;
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
  return { rest, booleans: new Set(), values: new Map(), json, home };
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

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    usage("--port must be an integer between 0 and 65535.");
  }
  return port;
}

function lifecycleContext(
  paths: ReturnType<typeof hostPaths>,
  options: LauncherRuntimeOptions,
  sink: OutputSink,
): LifecycleContext {
  return {
    paths,
    platform: options.platform,
    arch: options.arch,
    registry: options.registry,
    baselineEnv: options.baselineEnv,
    emit: (event) => emitEvent(sink, event),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.lifecycle ?? {}),
  };
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
      const linesRaw = flags.values.get("--lines") ?? flags.values.get("-n");
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

    if (verb === "up") {
      const flags = parseCommandFlags(rest, {
        values: ["--version", "--port", "--from"],
      });
      if (flags.rest.length) usage("up takes no positional arguments.");
      const port = parsePort(flags.values.get("--port"));
      const result = await up(lifecycleContext(paths, options, sink), {
        ...(flags.values.has("--version")
          ? { version: flags.values.get("--version") }
          : {}),
        ...(port !== undefined ? { port } : {}),
        ...(flags.values.has("--from")
          ? { from: resolve(flags.values.get("--from")!) }
          : {}),
      });
      emitResult(sink, { ...result });
      return 0;
    }

    if (verb === "down") {
      const flags = parseCommandFlags(rest, {
        booleans: ["--wait", "--force"],
        values: ["--timeout"],
      });
      if (flags.rest.length) usage("down takes no positional arguments.");
      let timeoutMs: number | undefined;
      if (flags.values.has("--timeout")) {
        const seconds = Number(flags.values.get("--timeout"));
        if (!Number.isFinite(seconds) || seconds <= 0) {
          usage("--timeout must be a positive number of seconds.");
        }
        timeoutMs = seconds * 1000;
      }
      const result = await down(lifecycleContext(paths, options, sink), {
        wait: flags.booleans.has("--wait"),
        force: flags.booleans.has("--force"),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      emitResult(sink, { ...result });
      return 0;
    }

    if (verb === "restart") {
      const flags = parseCommandFlags(rest, {
        booleans: ["--allow-downgrade", "--wait", "--force"],
        values: ["--version", "--timeout", "--from", "--port"],
      });
      if (flags.rest.length) usage("restart takes no positional arguments.");
      let timeoutMs: number | undefined;
      if (flags.values.has("--timeout")) {
        const seconds = Number(flags.values.get("--timeout"));
        if (!Number.isFinite(seconds) || seconds <= 0) {
          usage("--timeout must be a positive number of seconds.");
        }
        timeoutMs = seconds * 1000;
      }
      const port = parsePort(flags.values.get("--port"));
      const result = await restart(lifecycleContext(paths, options, sink), {
        ...(flags.values.has("--version")
          ? { version: flags.values.get("--version") }
          : {}),
        allowDowngrade: flags.booleans.has("--allow-downgrade"),
        wait: flags.booleans.has("--wait"),
        force: flags.booleans.has("--force"),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(flags.values.has("--from")
          ? { from: resolve(flags.values.get("--from")!) }
          : {}),
        ...(port !== undefined ? { port } : {}),
      });
      emitResult(sink, { ...result });
      return 0;
    }

    if (verb === "run") {
      const flags = parseCommandFlags(rest, {
        values: ["--version", "--port", "--from"],
      });
      if (flags.rest.length) usage("run takes no positional arguments.");
      const port = parsePort(flags.values.get("--port"));
      const ctx = lifecycleContext(paths, options, sink);
      const result = await run(ctx, {
        ...(flags.values.has("--version")
          ? { version: flags.values.get("--version") }
          : {}),
        ...(port !== undefined ? { port } : {}),
        ...(flags.values.has("--from")
          ? { from: resolve(flags.values.get("--from")!) }
          : {}),
        onReady: (ready) => emitResult(sink, { ...ready }),
      });
      void result;
      return 0;
    }

    usage(`Unknown command ${verb}.`);
  } catch (error) {
    emitError(sink, error instanceof Error ? error : new Error(String(error)));
    return exitCodeFor(error);
  }
}
