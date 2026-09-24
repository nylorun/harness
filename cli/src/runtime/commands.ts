import { resolve } from "node:path";
import { CliError } from "../errors.js";
import {
  exitCodeForStatusState,
} from "./exit-codes.js";
import {
  launcher,
  resolveHome,
  throwOnLauncherFailure,
  type LauncherHandle,
  type LauncherOptions,
} from "./launcher.js";
import { runtimeVersion } from "./version.js";

export const runtimeUsage = `  runtime up [--port <n>] [--version <v>]
  runtime down [--wait] [--force] [--timeout <seconds>]
  runtime status [--json] [--env]
  runtime logs [-f|--follow] [-n <lines>] [--tenant <id>|--all]
  runtime restart [--port <n>] [--version <v>] [--allow-downgrade] [--wait|--force]
  runtime run [--port <n>] [--version <v>]
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
  const valueNames = new Set(allowed.values ?? []);
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
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw usageError("--port must be an integer between 0 and 65535.");
  return port;
}

export interface RuntimeCommandOptions extends LauncherOptions {
  home?: string;
  /** Injected launcher handle (tests). */
  handle?: LauncherHandle;
  /** Hook for `status --env` (F2 wires Project link exports). */
  envHook?: () => void | Promise<void>;
}

/**
 * `nylorun runtime …` and the `up` / `down` / `logs` aliases.
 * Dispatch from `cli.ts` is owned by WS-F2 (one-line import change).
 */
export async function runtimeCommand(
  args: readonly string[],
  options: RuntimeCommandOptions = {},
): Promise<void> {
  const home =
    options.home ??
    (options.env?.NYLORUN_HOME
      ? resolve(options.env.NYLORUN_HOME)
      : resolveHome());
  const handle =
    options.handle ??
    (await launcher(home, {
      version: options.version,
      registry: options.registry,
      fetchImpl: options.fetchImpl,
      env: options.env,
      onProgress: options.onProgress,
      bootstrap: options.bootstrap,
    }));

  const [verb, ...rest] = args;
  if (verb === "up" || verb === "start") {
    const flags = parseRuntimeFlags(rest, {
      values: ["--port", "--version"],
    });
    if (flags.rest.length) throw usageError(runtimeUsage);
    const port = parsePort(flags.values.get("--port"));
    const version = flags.values.get("--version") ?? runtimeVersion();
    const invokeArgs = ["up", "--version", version];
    if (port !== undefined) invokeArgs.push("--port", String(port));
    const outcome = await handle.invoke(invokeArgs);
    throwOnLauncherFailure(outcome);
    const result = outcome.result ?? {};
    const url = typeof result.url === "string" ? result.url : undefined;
    const started = result.started === true;
    if (url && started) {
      console.log(
        `Started the Runtime Host at ${url}${result.pid ? ` (pid ${result.pid})` : ""}. It stays running; stop it with "nylorun runtime down".`,
      );
    }
    printUpResult(result);
    console.log(`\n→ npx nylorun dev`);
    return;
  }

  if (verb === "down" || verb === "stop") {
    const flags = parseRuntimeFlags(rest, {
      booleans: ["--wait", "--force"],
      values: ["--timeout"],
    });
    if (flags.rest.length) throw usageError(runtimeUsage);
    if (flags.booleans.has("--wait") && flags.booleans.has("--force")) {
      throw usageError("Use either --wait or --force, not both.");
    }
    const invokeArgs = ["down"];
    if (flags.booleans.has("--wait")) invokeArgs.push("--wait");
    if (flags.booleans.has("--force")) invokeArgs.push("--force");
    if (flags.values.has("--timeout")) {
      const seconds = Number(flags.values.get("--timeout"));
      if (!Number.isFinite(seconds) || seconds <= 0)
        throw usageError("--timeout must be a positive number of seconds.");
      invokeArgs.push("--timeout", String(seconds));
    }
    const outcome = await handle.invoke(invokeArgs);
    throwOnLauncherFailure(outcome);
    const stopped = outcome.result?.stopped === true;
    console.log(
      stopped
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
    const json =
      flags.booleans.has("--json") || flags.values.get("--output") === "json";
    if (
      flags.values.has("--output") &&
      flags.values.get("--output") !== "json" &&
      flags.values.get("--output") !== "text"
    ) {
      throw usageError("--output must be text or json.");
    }
    if (flags.booleans.has("--env")) {
      if (options.envHook) await options.envHook();
      else {
        console.log(
          "# runtime status --env requires a Project link (nylorun dev). Coming in a later release.",
        );
      }
      return;
    }
    const outcome = await handle.invoke(["status"]);
    throwOnLauncherFailure(outcome);
    const result = outcome.result ?? {};
    if (json) {
      console.log(JSON.stringify({ ...result, cliRuntimeVersion: runtimeVersion() }, null, 2));
    } else {
      printStatus(result);
    }
    const state = typeof result.state === "string" ? result.state : undefined;
    const code = exitCodeForStatusState(state);
    if (code !== undefined) process.exitCode = code;
    return;
  }

  if (verb === "logs") {
    const flags = parseRuntimeFlags(rest, {
      booleans: ["-f", "--follow", "--all"],
      values: ["-n", "--lines", "--tenant"],
    });
    if (flags.rest.length) throw usageError(runtimeUsage);
    if (flags.booleans.has("--all") && flags.values.has("--tenant")) {
      throw usageError("Use either --tenant or --all, not both.");
    }
    const linesRaw = flags.values.get("-n") ?? flags.values.get("--lines");
    const lines = linesRaw !== undefined ? Number(linesRaw) : 200;
    if (!Number.isInteger(lines) || lines < 1)
      throw usageError("-n must be a positive integer.");
    const follow =
      flags.booleans.has("-f") || flags.booleans.has("--follow");
    const invokeArgs = ["logs", "--lines", String(lines)];
    if (follow) invokeArgs.push("--follow");
    if (flags.booleans.has("--all")) invokeArgs.push("--all");
    if (flags.values.has("--tenant")) {
      invokeArgs.push("--tenant", flags.values.get("--tenant")!);
    }
    const outcome = follow
      ? await handle.invokeStreaming(invokeArgs)
      : await handle.invoke(invokeArgs);
    if (outcome.exitCode !== 0) {
      if (
        outcome.error?.code === "not_found" ||
        /no .*log/i.test(outcome.error?.message ?? outcome.stderr)
      ) {
        throw new CliError(
          `No Runtime Host log under ${home}. Start one with "nylorun runtime up".`,
          3,
        );
      }
      throwOnLauncherFailure(outcome);
    }
    return;
  }

  if (verb === "restart") {
    const flags = parseRuntimeFlags(rest, {
      booleans: ["--allow-downgrade", "--wait", "--force"],
      values: ["--port", "--version"],
    });
    if (flags.rest.length) throw usageError(runtimeUsage);
    if (flags.booleans.has("--wait") && flags.booleans.has("--force")) {
      throw usageError("Use either --wait or --force, not both.");
    }
    const port = parsePort(flags.values.get("--port"));
    const version = flags.values.get("--version") ?? runtimeVersion();
    const invokeArgs = ["restart", "--version", version];
    if (port !== undefined) invokeArgs.push("--port", String(port));
    if (flags.booleans.has("--allow-downgrade"))
      invokeArgs.push("--allow-downgrade");
    if (flags.booleans.has("--wait")) invokeArgs.push("--wait");
    if (flags.booleans.has("--force")) invokeArgs.push("--force");
    const outcome = await handle.invoke(invokeArgs);
    throwOnLauncherFailure(outcome);
    printUpResult(outcome.result ?? {});
    return;
  }

  if (verb === "run") {
    const flags = parseRuntimeFlags(rest, {
      values: ["--port", "--version"],
    });
    if (flags.rest.length) throw usageError(runtimeUsage);
    const port = parsePort(flags.values.get("--port"));
    const version = flags.values.get("--version") ?? runtimeVersion();
    const invokeArgs = ["run", "--version", version];
    if (port !== undefined) invokeArgs.push("--port", String(port));
    const outcome = await handle.invokeStreaming(invokeArgs);
    throwOnLauncherFailure(outcome);
    return;
  }

  throw usageError(runtimeUsage);
}

function printUpResult(result: Record<string, unknown>): void {
  const lines: [string, string | undefined][] = [
    ["Host", typeof result.hostId === "string" ? result.hostId : undefined],
    ["URL", typeof result.url === "string" ? result.url : undefined],
    [
      "PID",
      typeof result.pid === "number" ? String(result.pid) : undefined,
    ],
    [
      "Version",
      typeof result.version === "string" ? result.version : undefined,
    ],
    [
      "Started",
      result.started === true
        ? "yes"
        : result.started === false
          ? "already running"
          : undefined,
    ],
  ];
  const width = Math.max(...lines.map(([label]) => label.length));
  for (const [label, value] of lines) {
    if (value !== undefined) console.log(`${label.padEnd(width)}  ${value}`);
  }
}

function printStatus(result: Record<string, unknown>): void {
  const lines: [string, string | undefined][] = [
    ["Home", typeof result.home === "string" ? result.home : undefined],
    ["State", typeof result.state === "string" ? result.state : undefined],
    ["Host", typeof result.hostId === "string" ? result.hostId : undefined],
    ["URL", typeof result.url === "string" ? result.url : undefined],
    [
      "PID",
      typeof result.pid === "number" ? String(result.pid) : undefined,
    ],
    [
      "Version",
      typeof result.version === "string" ? result.version : undefined,
    ],
    [
      "Runtime",
      typeof result.runtimeVersion === "string"
        ? result.runtimeVersion
        : undefined,
    ],
    ["CLI Runtime", runtimeVersion()],
    [
      "Installed",
      Array.isArray(result.installed)
        ? (result.installed as string[]).join(", ") || "(none)"
        : undefined,
    ],
  ];
  const width = Math.max(...lines.map(([label]) => label.length));
  for (const [label, value] of lines) {
    if (value !== undefined) console.log(`${label.padEnd(width)}  ${value}`);
  }
}

export { runtimeVersion } from "./version.js";
export { launcher } from "./launcher.js";
export { bootstrap } from "./bootstrap.js";
