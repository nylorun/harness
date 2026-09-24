#!/usr/bin/env node
import "./runtime/baseline.js";
import { ConfigurationCancelled, configureProvider, fetchModelCatalog } from "./model/configure.js";
import { putHostModel } from "./model/host-model.js";
import { develop, developmentPreflight } from "./dev.js";
import { CliError } from "./errors.js";
import { runtimeCommand, runtimeUsage } from "./runtime/commands.js";
import { findProjectRoot, requireProjectRoot } from "./project/root.js";
import { printLinkedEnvExports } from "./project/attach.js";
import { readLink as readProjectLink } from "./project/link.js";
import { readCredentials as readProjectCredentials } from "./project/credentials.js";
import { tenantCommand } from "./tenant/commands.js";

const usage = `nylorun <runtime|up|down|logs|dev|configure|doctor|tenant>

${runtimeUsage}

  dev [entry] [--ephemeral]
  configure
  doctor sandbox [--json]  show which sandbox backend this Tenant's Host offers
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
    // F2-7: envHook prints the linked Project's three variables.
    return await runtimeCommand(args, {
      envHook: async () => {
        const root = findProjectRoot() ?? process.cwd();
        await printLinkedEnvExports(root);
      },
    });
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
      booleans: ["--ephemeral"],
    });
    if (flags.rest.length > 1) throw usageError(usage);
    requireProjectRoot();
    developmentPreflight([
      ...flags.rest,
      ...[...flags.booleans],
    ]);
    process.exitCode = await develop({
      ...(flags.rest[0] ? { entry: flags.rest[0] } : {}),
      flags: [...flags.booleans],
    });
    return;
  }

  if (command === "serve" || command === "studio") {
    throw usageError(
      command === "serve"
        ? "nylorun serve was removed. Use nylorun dev [entry] in development, or node dist/src/main.js with NYLORUN_RUNTIME_URL, NYLORUN_TENANT and NYLORUN_SERVER_KEY."
        : "nylorun studio was removed. Run nylorun-studio (npm run studio) instead.",
    );
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
    const catalog = await fetchModelCatalog({
      url: auth.url,
      key: auth.key,
      tenantId: auth.tenantId,
    });
    const prompted = await configureProvider({
      signal: controller.signal,
      catalog,
    });
    await putHostModel(auth.url, auth.key, prompted, auth.tenantId);
    return;
  }

  throw usageError(usage);
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
