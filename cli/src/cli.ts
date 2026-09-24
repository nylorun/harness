#!/usr/bin/env node
import "./host/baseline.js";
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
import { runtimeCommand, runtimeUsage } from "./host/commands.js";
import { statusCommand } from "./host/lifecycle.js";
import { hostPaths, resolveHostRoot } from "./host/root.js";
import { findProjectRoot, requireProjectRoot } from "./project/root.js";
import { printLinkedEnvExports } from "./project/attach.js";
import { readLink as readProjectLink } from "./project/link.js";
import { readCredentials as readProjectCredentials } from "./project/credentials.js";
import { tenantCommand } from "./tenant/commands.js";

const usage = `nylorun <runtime|up|down|logs|dev|serve|configure|studio|doctor|tenant>

${runtimeUsage}

  dev [--no-studio] [--no-open] [--no-autostart] [--ephemeral]
  serve [entry] [--no-autostart] [--ephemeral]
  configure
  studio [--runtime-url <http(s)-url>] [--port <n>] [--no-open]
  doctor sandbox [--json]  show which sandbox backend this machine offers
  tenant current|list [--json]|use <name-or-id>|status [--json]|reset|delete`;

interface Flags {
  rest: string[];
  booleans: Set<string>;
  values: Map<string, string>;
}

function parseFlags(
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
    if (arg === "--global" || arg === "--db") {
      throw usageError(
        `${arg} was removed. Use the Runtime Host root (NYLORUN_HOME) and a Project link instead.`,
      );
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
  return { rest, booleans, values };
}

const usageError = (message: string) => new CliError(message, 2);

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw usageError("--port must be an integer between 1 and 65535.");
  return port;
}

async function resolveLinkedAuth(projectRoot: string): Promise<{
  url: string;
  key: string;
  tenantId: string;
  tenantName: string;
}> {
  const link = await readProjectLink(projectRoot);
  const credentials = await readProjectCredentials(projectRoot);
  if (link && credentials) {
    return {
      url: link.hostUrl,
      key: credentials.applicationKey,
      tenantId: link.tenantId,
      tenantName: link.tenantId,
    };
  }
  const url = process.env.NYLORUN_RUNTIME_URL?.trim();
  const key = process.env.NYLORUN_SERVER_KEY?.trim();
  const tenantId = process.env.NYLORUN_TENANT?.trim();
  if (url && key && tenantId) {
    return { url, key, tenantId, tenantName: tenantId };
  }
  throw new CliError(
    `No Project link in ${projectRoot}. Run nylorun dev, or set NYLORUN_RUNTIME_URL, NYLORUN_SERVER_KEY and NYLORUN_TENANT.`,
    1,
  );
}

async function startStudio(
  agentServerUrl: string,
  serverKey: string,
  tenant: { id: string; name: string },
  open: boolean,
  port?: number,
) {
  let entry: string;
  try {
    entry = createRequire(join(process.cwd(), "package.json")).resolve(
      "@nylorun/studio",
    );
  } catch {
    throw new Error("Install @nylorun/studio to use the Studio dashboard.");
  }
  const studio = await import(pathToFileURL(entry).href);
  return studio.startStudio({
    runtimeUrl: agentServerUrl,
    serverKey,
    tenant,
    open,
    ...(port === undefined ? {} : { port }),
  });
}

async function main() {
  const [rawCommand, ...rawArgs] = process.argv.slice(2);
  if (!rawCommand || rawCommand === "--help" || rawCommand === "-h")
    return void console.log(usage);
  const aliases: Record<string, string> = {
    up: "up",
    down: "down",
    logs: "logs",
  };
  const command = rawCommand in aliases ? "runtime" : rawCommand;
  const args =
    rawCommand in aliases ? [aliases[rawCommand]!, ...rawArgs] : rawArgs;

  if (command === "tenant") return await tenantCommand(args);

  if (command === "runtime") {
    if (args[0] === "status" && args.includes("--env")) {
      await statusCommand({
        env: true,
        envHook: async () => {
          const root = findProjectRoot() ?? process.cwd();
          await printLinkedEnvExports(root);
        },
      });
      return;
    }
    if (rawCommand === "logs") {
      const root = findProjectRoot();
      if (root) {
        const link = await readProjectLink(root);
        if (link) {
          const paths = hostPaths(resolveHostRoot());
          const tenantLog = join(
            paths.tenants,
            link.tenantId,
            "logs",
            "tenant.log",
          );
          const flags = args.slice(1);
          const follow = flags.includes("-f") || flags.includes("--follow");
          const { readFile, stat } = await import("node:fs/promises");
          const { existsSync, openSync, readSync, closeSync, fstatSync } =
            await import("node:fs");
          if (!existsSync(tenantLog)) {
            throw new CliError(
              `No Tenant log at ${tenantLog}. Start the Project with nylorun dev first.`,
              3,
            );
          }
          const nIndex = flags.indexOf("-n");
          const lines = nIndex >= 0 ? Number(flags[nIndex + 1] ?? 200) : 200;
          if (!Number.isInteger(lines) || lines < 1)
            throw usageError("-n must be a positive integer.");
          const text = await readFile(tenantLog, "utf8");
          for (const line of text.trimEnd().split("\n").slice(-lines)) {
            process.stdout.write(`${line}\n`);
          }
          if (!follow) return;
          let size = (await stat(tenantLog)).size;
          await new Promise<void>((resolvePromise) => {
            process.once("SIGINT", () => resolvePromise());
            process.once("SIGTERM", () => resolvePromise());
            const poll = setInterval(() => {
              try {
                const fd = openSync(tenantLog, "r");
                const next = fstatSync(fd).size;
                if (next > size) {
                  const buffer = Buffer.alloc(next - size);
                  readSync(fd, buffer, 0, buffer.length, size);
                  size = next;
                  process.stdout.write(buffer);
                }
                closeSync(fd);
              } catch {
                /* log rotated or removed */
              }
            }, 500);
            poll.unref();
          });
          return;
        }
      }
    }
    return await runtimeCommand(args);
  }

  if (command === "doctor") {
    const [topic, ...options] = args;
    if (topic !== "sandbox" || options.some((option) => option !== "--json"))
      throw usageError("Usage: nylorun doctor sandbox [--json]");
    const { doctorSandbox } = await import("./doctor.js");
    await doctorSandbox({ json: options.includes("--json") });
    return;
  }

  if (command === "dev") {
    const flags = parseFlags(args, {
      booleans: ["--no-studio", "--no-open", "--no-autostart", "--ephemeral"],
    });
    if (flags.rest.length) throw usageError(usage);
    requireProjectRoot();
    developmentPreflight(
      [...flags.booleans].filter((flag) => flag !== "--ephemeral"),
    );
    process.exitCode = await develop([...flags.booleans]);
    return;
  }

  if (command === "serve") {
    const flags = parseFlags(args, {
      booleans: ["--no-autostart", "--ephemeral"],
    });
    if (flags.rest.length > 1) throw usageError(usage);
    requireProjectRoot();
    await (
      await import("./launcher.js")
    ).serve(flags.rest[0], {
      autostart: !flags.booleans.has("--no-autostart"),
      ephemeral: flags.booleans.has("--ephemeral"),
    });
    return;
  }

  if (command === "configure") {
    const flags = parseFlags(args);
    if (flags.rest.length) throw usageError(usage);
    const projectRoot = findProjectRoot() ?? process.cwd();
    const auth = await resolveLinkedAuth(projectRoot);
    const controller = new AbortController();
    const cancel = (signal: "SIGINT" | "SIGTERM") =>
      controller.abort(new ConfigurationCancelled(signal));
    process.once("SIGINT", () => cancel("SIGINT"));
    process.once("SIGTERM", () => cancel("SIGTERM"));
    const health = await fetch(`${auth.url}/health`).catch(() => undefined);
    if (!health?.ok)
      throw new CliError(
        `No Runtime Host is listening at ${auth.url}. Start one with "nylorun runtime up".`,
        6,
      );
    const prompted = await configureProvider({ signal: controller.signal });
    await putHostModel(auth.url, auth.key, prompted, auth.tenantId);
    return;
  }

  if (command !== "studio") throw usageError(usage);
  const flags = parseFlags(args, {
    booleans: ["--no-open"],
    values: ["--runtime-url", "--studio-port", "--port"],
  });
  if (flags.rest.length) throw usageError(usage);
  const projectRoot = findProjectRoot() ?? process.cwd();
  const auth = await resolveLinkedAuth(projectRoot);
  const runtimeUrl = flags.values.get("--runtime-url") ?? auth.url;
  const studioPort = flags.values.has("--studio-port")
    ? parsePort(flags.values.get("--studio-port"))
    : flags.values.has("--port")
      ? parsePort(flags.values.get("--port"))
      : undefined;
  const dashboard = await startStudio(
    runtimeUrl,
    auth.key,
    { id: auth.tenantId, name: auth.tenantName },
    !flags.booleans.has("--no-open"),
    studioPort,
  );
  console.log(`Studio on ${dashboard.address}`);
  await new Promise<void>((resolve, reject) => {
    const close = () => void dashboard.close().then(resolve, reject);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

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
        : 1,
    );
  },
);
