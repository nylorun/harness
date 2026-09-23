#!/usr/bin/env node
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  ConfigurationCancelled,
  configureProvider,
} from "./model/configure.js";
import { putHostModel } from "./model/host-model.js";

import { develop, developmentPreflight } from "./dev.js";
import { CliError } from "./errors.js";
import {
  loadScopeEnvironment,
  resolveScope,
  type Scope,
  type ScopeRequest,
} from "./scope.js";
import {
  cliRuntimeVersion,
  ensureRuntime,
  hostStatus,
  startHost,
  stopHost,
  tailLog,
  warnIncompatible,
} from "./runtime-host.js";
import { localCredentials } from "./project-runner.js";

const usage = `nylorun <runtime|up|down|logs|dev|serve|configure|studio>

  runtime start [--foreground] [--restart] [--port <n>] [--db <path>] [--global]
  runtime stop [--global] [--timeout <seconds>]
  runtime status [--output json] [--global]
  runtime logs [-f] [-n <lines>] [--global]
  up                       alias for "runtime start"
  down                     alias for "runtime stop"
  logs                     alias for "runtime logs"

  dev [--no-studio] [--no-open] [--no-autostart] [--port <n>]
  serve [entry] [--no-autostart] [--port <n>]
  configure [--global]
  studio [--runtime-url <http(s)-url>] [--port <n>] [--no-open]`;

interface Flags {
  scope: ScopeRequest;
  rest: string[];
  booleans: Set<string>;
  values: Map<string, string>;
}

/**
 * Flags are parsed before the scope is resolved so --port can win over a PORT in .env, which
 * is only loaded once the project root is known.
 */
function parseFlags(
  args: readonly string[],
  allowed: { booleans?: readonly string[]; values?: readonly string[] } = {}
): Flags {
  const booleans = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  const scope: ScopeRequest = {};
  const booleanNames = new Set(["--global", ...(allowed.booleans ?? [])]);
  const valueNames = new Set(["--port", "--db", ...(allowed.values ?? [])]);
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
    throw usageError(usage);
  }
  if (booleans.has("--global")) scope.global = true;
  if (values.has("--port")) scope.port = parsePort(values.get("--port"));
  if (values.has("--db")) scope.db = values.get("--db")!;
  return { scope, rest, booleans, values };
}

const usageError = (message: string) => new CliError(message, 2);

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw usageError("--port must be an integer between 1 and 65535.");
  return port;
}

async function serverKeyFor(scope: Scope): Promise<string> {
  return (
    process.env.NYLORUN_SERVER_KEY ??
    (await localCredentials(scope.credentialsPath)).serverKey
  );
}

async function startStudio(
  agentServerUrl: string,
  serverKey: string,
  open: boolean,
  port?: number
) {
  let entry: string;
  try {
    entry = createRequire(join(process.cwd(), "package.json")).resolve(
      "@nylorun/studio"
    );
  } catch {
    throw new Error("Install @nylorun/studio to use the Studio dashboard.");
  }
  const studio = await import(pathToFileURL(entry).href);
  return studio.startStudio({
    runtimeUrl: agentServerUrl,
    serverKey,
    open,
    ...(port === undefined ? {} : { port }),
  });
}

function printStatus(status: Awaited<ReturnType<typeof hostStatus>>): void {
  const { scope, runtime } = status;
  const lines: [string, string | undefined][] = [
    ["Scope", `${scope.kind} (${scope.kind === "project" ? scope.root : scope.dataDir})`],
    ["State", status.state],
    ["URL", scope.url],
    ["PID", runtime?.pid ? String(runtime.pid) : status.pid ? String(status.pid) : undefined],
    ["Runtime", status.version],
    ["CLI expects", cliRuntimeVersion()],
    ["Database", scope.sqlitePath],
    ["Log", scope.logPath],
    ["Started", runtime?.startedAt],
  ];
  const width = Math.max(...lines.map(([label]) => label.length));
  for (const [label, value] of lines)
    if (value !== undefined)
      console.log(`${label.padEnd(width)}  ${value}`);
}

async function runtimeCommand(args: readonly string[]): Promise<void> {
  const [verb, ...rest] = args;
  if (verb === "start") {
    const flags = parseFlags(rest, { booleans: ["--foreground", "--restart"] });
    if (flags.rest.length) throw usageError(usage);
    const scope = resolveScope(flags.scope);
    loadScopeEnvironment(scope);
    const before = await hostStatus(scope);
    if (before.state === "running" && !flags.booleans.has("--restart")) {
      console.log(
        `Runtime already running for ${scope.label} at ${scope.url} (pid ${before.runtime?.pid ?? before.pid}).`
      );
      warnIncompatible(scope, before);
      return;
    }
    const status = await startHost(scope, {
      foreground: flags.booleans.has("--foreground"),
      restart: flags.booleans.has("--restart"),
    });
    printStatus(status);
    console.log(`\n→ npx nylorun dev`);
    return;
  }
  if (verb === "stop") {
    const flags = parseFlags(rest, { values: ["--timeout"] });
    if (flags.rest.length) throw usageError(usage);
    const scope = resolveScope(flags.scope);
    const seconds = flags.values.has("--timeout")
      ? Number(flags.values.get("--timeout"))
      : undefined;
    if (seconds !== undefined && (!Number.isFinite(seconds) || seconds <= 0))
      throw usageError("--timeout must be a positive number of seconds.");
    const result = await stopHost(scope, {
      ...(seconds === undefined ? {} : { timeoutMs: seconds * 1000 }),
    });
    console.log(
      result === "stopped"
        ? `Stopped the Runtime for ${scope.label}. SQLite and credentials are kept in ${scope.dataDir}.`
        : `No Runtime is running for ${scope.label}.`
    );
    return;
  }
  if (verb === "status") {
    const flags = parseFlags(rest, { values: ["--output"] });
    if (flags.rest.length) throw usageError(usage);
    const output = flags.values.get("--output") ?? "text";
    if (output !== "text" && output !== "json")
      throw usageError("--output must be text or json.");
    const scope = resolveScope(flags.scope);
    const status = await hostStatus(scope);
    if (output === "json")
      console.log(
        JSON.stringify(
          {
            scope: scope.kind,
            root: scope.kind === "project" ? scope.root : scope.dataDir,
            url: scope.url,
            state: status.state,
            pid: status.runtime?.pid ?? status.pid ?? null,
            runtimeVersion: status.version ?? null,
            cliVersion: cliRuntimeVersion() ?? null,
            scopeId: status.scopeId ?? null,
            sqlitePath: scope.sqlitePath,
            logPath: scope.logPath,
            startedAt: status.runtime?.startedAt ?? null,
          },
          null,
          2
        )
      );
    else printStatus(status);
    if (status.state !== "running")
      process.exitCode = status.state === "port-conflict" ? 4 : 3;
    return;
  }
  if (verb === "logs") {
    const flags = parseFlags(rest, { booleans: ["-f"], values: ["-n"] });
    if (flags.rest.length) throw usageError(usage);
    const lines = flags.values.has("-n") ? Number(flags.values.get("-n")) : 200;
    if (!Number.isInteger(lines) || lines < 1)
      throw usageError("-n must be a positive integer.");
    await tailLog(resolveScope(flags.scope), {
      follow: flags.booleans.has("-f"),
      lines,
    });
    return;
  }
  throw usageError(usage);
}

async function main() {
  const [rawCommand, ...rawArgs] = process.argv.slice(2);
  if (!rawCommand || rawCommand === "--help" || rawCommand === "-h")
    return void console.log(usage);
  const aliases: Record<string, string> = {
    up: "start",
    down: "stop",
    logs: "logs",
  };
  const command = rawCommand in aliases ? "runtime" : rawCommand;
  const args =
    rawCommand in aliases ? [aliases[rawCommand]!, ...rawArgs] : rawArgs;

  if (command === "runtime") return await runtimeCommand(args);

  if (command === "dev") {
    const flags = parseFlags(args, {
      booleans: ["--no-studio", "--no-open", "--no-autostart"],
    });
    if (flags.rest.length) throw usageError(usage);
    const scope = resolveScope(flags.scope);
    loadScopeEnvironment(scope);
    // The port is re-resolved after .env so a project file can set PORT, while --port wins.
    const resolved = resolveScope(flags.scope);
    process.env.PORT = String(resolved.port);
    developmentPreflight([...flags.booleans]);
    // The supervisor checks the host before spawning tsx so port conflicts, version skew and
    // --no-autostart surface with their own exit codes instead of a generic watcher failure.
    await ensureRuntime(resolved, {
      autostart: !flags.booleans.has("--no-autostart"),
    });
    process.exitCode = await develop([...flags.booleans]);
    return;
  }

  if (command === "serve") {
    const flags = parseFlags(args, { booleans: ["--no-autostart"] });
    if (flags.rest.length > 1) throw usageError(usage);
    const scope = resolveScope(flags.scope);
    loadScopeEnvironment(scope);
    const resolved = resolveScope(flags.scope);
    // serve runs the project in this process, so runProject's own errors carry their exit
    // codes out; it validates the agent registry before it touches the host.
    await (
      await import("./launcher.js")
    ).serve(flags.rest[0], {
      autostart: !flags.booleans.has("--no-autostart"),
      scope: resolved,
    });
    return;
  }

  if (command === "configure") {
    const flags = parseFlags(args);
    if (flags.rest.length) throw usageError(usage);
    const scope = resolveScope(flags.scope);
    loadScopeEnvironment(scope);
    const controller = new AbortController();
    const cancel = (signal: "SIGINT" | "SIGTERM") =>
      controller.abort(new ConfigurationCancelled(signal));
    process.once("SIGINT", () => cancel("SIGINT"));
    process.once("SIGTERM", () => cancel("SIGTERM"));
    const serverKey = await serverKeyFor(scope);
    const health = await fetch(`${scope.url}/health`).catch(() => undefined);
    if (!health?.ok)
      throw new CliError(
        `No Runtime is listening at ${scope.url} for ${scope.label}. Start one with "nylorun up".`,
        6
      );
    const prompted = await configureProvider({ signal: controller.signal });
    await putHostModel(scope.url, serverKey, prompted);
    return;
  }

  if (command !== "studio") throw usageError(usage);
  const flags = parseFlags(args, {
    booleans: ["--no-open"],
    values: ["--runtime-url", "--studio-port"],
  });
  if (flags.rest.length) throw usageError(usage);
  const scope = resolveScope(flags.scope);
  const runtimeUrl = flags.values.get("--runtime-url") ?? scope.url;
  const studioPort = flags.values.has("--studio-port")
    ? parsePort(flags.values.get("--studio-port"))
    : flags.scope.port !== undefined && flags.values.has("--runtime-url")
      ? flags.scope.port
      : undefined;
  const dashboard = await startStudio(
    runtimeUrl,
    await serverKeyFor(scope),
    !flags.booleans.has("--no-open"),
    studioPort
  );
  console.log(`Studio on ${dashboard.address}`);
  await new Promise<void>((resolve, reject) => {
    const close = () => void dashboard.close().then(resolve, reject);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

/**
 * Probing a port that answers but is not a Runtime can leave a pooled connection holding the
 * event loop open, so a finished command exits explicitly once its output has drained.
 */
async function finish(code: number): Promise<never> {
  process.exitCode = code;
  for (const stream of [process.stdout, process.stderr])
    await new Promise<void>((resolve) => stream.write("", () => resolve()));
  process.exit(code);
}

void main().then(
  () => finish(process.exitCode === undefined ? 0 : Number(process.exitCode)),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    return finish(
      error instanceof ConfigurationCancelled || error instanceof CliError
        ? error.exitCode
        : 1
    );
  }
);
