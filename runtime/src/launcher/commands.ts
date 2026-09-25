import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_PROTOCOL,
  LAUNCHER_PROTOCOL,
} from "@nylorun/core/compatibility";
import { TENANT_SCHEMA_VERSION } from "../tenant/schema.js";
import { RUNTIME_VERSION } from "../version.js";
import { LauncherError, UsageError } from "./errors.js";
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
  version                  also --version
  up [--port <n>] [--allow-downgrade]
  down [--wait [--timeout <s>]] [--force]
  restart [--port <n>] [--allow-downgrade] [--wait | --force]
  run [--port <n>] [--allow-downgrade]
  status
  logs [--lines <n>] [--follow] [--tenant <id> | --all]`;

/** The Runtime needs node:sqlite and Node 24 APIs. */
const MIN_NODE_MAJOR = 24;

export interface LauncherRuntimeOptions {
  home: string;
  platform: NodeJS.Platform;
  /** Node running this launcher (`process.execPath`); the Host runs on it. */
  nodeBinary: string;
  /** `process.versions.node`; the launcher refuses Node older than 24. */
  nodeVersion: string;
  sink: OutputSink;
  /** Allowlisted ambient baseline from main.ts. */
  baselineEnv: Readonly<Record<string, string | undefined>>;
  fetchImpl?: typeof fetch;
  /** Abort signal for logs --follow (tests). */
  signal?: AbortSignal;
  /** Optional lifecycle overrides for tests. */
  lifecycle?: Partial<
    Pick<
      LifecycleContext,
      | "spawnHost"
      | "onSignal"
      | "lock"
      | "fetchImpl"
      | "hostEntry"
      | "runtimeVersion"
      | "tenantSchemaMax"
    >
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
    rest.push(arg === "--version" && rest.length === 0 ? "version" : arg);
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
    nodeBinary: options.nodeBinary,
    hostEntry: fileURLToPath(new URL("../host/main.js", import.meta.url)),
    runtimeVersion: RUNTIME_VERSION,
    tenantSchemaMax: TENANT_SCHEMA_VERSION,
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

    if (verb === "version") {
      const flags = parseCommandFlags(rest);
      if (flags.rest.length) usage("version takes no arguments.");
      emitResult(sink, {
        runtimeVersion: options.lifecycle?.runtimeVersion ?? RUNTIME_VERSION,
        launcherProtocol: LAUNCHER_PROTOCOL,
        protocol: HOST_PROTOCOL,
        node: options.nodeVersion,
      });
      return 0;
    }

    const nodeMajor = Number(options.nodeVersion.split(".")[0]);
    if (!(nodeMajor >= MIN_NODE_MAJOR)) {
      throw new LauncherError(
        "platform_unsupported",
        `Node ${MIN_NODE_MAJOR} or newer is required to run the Nylorun Runtime (found ${options.nodeVersion}).`,
        `Install Node ${MIN_NODE_MAJOR}, then reinstall: npm install --global @nylorun/runtime`,
      );
    }

    if (verb === "status") {
      const flags = parseCommandFlags(rest);
      if (flags.rest.length) usage("status takes no arguments.");
      const result = await status(
        paths,
        options.lifecycle?.runtimeVersion ?? RUNTIME_VERSION,
      );
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
        booleans: ["--allow-downgrade"],
        values: ["--port"],
      });
      if (flags.rest.length) usage("up takes no positional arguments.");
      const port = parsePort(flags.values.get("--port"));
      const result = await up(lifecycleContext(paths, options, sink), {
        ...(port !== undefined ? { port } : {}),
        allowDowngrade: flags.booleans.has("--allow-downgrade"),
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
        values: ["--timeout", "--port"],
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
        allowDowngrade: flags.booleans.has("--allow-downgrade"),
        wait: flags.booleans.has("--wait"),
        force: flags.booleans.has("--force"),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(port !== undefined ? { port } : {}),
      });
      emitResult(sink, { ...result });
      return 0;
    }

    if (verb === "run") {
      const flags = parseCommandFlags(rest, {
        booleans: ["--allow-downgrade"],
        values: ["--port"],
      });
      if (flags.rest.length) usage("run takes no positional arguments.");
      const port = parsePort(flags.values.get("--port"));
      const ctx = lifecycleContext(paths, options, sink);
      const result = await run(ctx, {
        ...(port !== undefined ? { port } : {}),
        allowDowngrade: flags.booleans.has("--allow-downgrade"),
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
