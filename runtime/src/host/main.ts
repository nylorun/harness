/**
 * Runtime Host process entry (`@nylorun/runtime/server`).
 *
 * Reads only `NYLORUN_HOME` from the environment (falls back to `~/.nylorun`).
 * Absolute Host root is resolved once and passed down.
 *
 * Integration I1 wires `createTenantModule` + `openTenantRuntime`. Until then
 * this entry boots with an empty stub module so `/health` and `/ready` work.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdminTenant,
  AdminTenantStatus,
  HostAggregate,
  TenantEnvelope,
} from "@nylorun/core/contracts";
import { hostPaths } from "../tenant/paths.js";
import type {
  BootstrapPrincipal,
  TenantModule,
  TenantResolution,
} from "../tenant/types.js";
import type {
  HostConfigFile,
  HostCredentialsFile,
  HostStateFile,
} from "./config.js";
import { configForFactory } from "./config-for.js";
import { createHost, type CreateHostOptions } from "./create-host.js";
import {
  baselineEnvironment,
  hostProcessEnvironment,
} from "./environment.js";
import {
  HostListenError,
  EXIT_PORT_IN_USE,
  EXIT_NON_LOOPBACK,
} from "./http.js";
import { createHostLogger } from "./logger.js";
import { RUNTIME_VERSION } from "../version.js";

const entry = fileURLToPath(import.meta.url);
const nodeRequire = createRequire(import.meta.url);

function coreVersion(): string {
  try {
    return nodeRequire("@nylorun/core/package.json").version as string;
  } catch {
    return "unknown";
  }
}

/**
 * Empty Tenant module until Integration I1 plugs WS-B's `createTenantModule`.
 * // TENANTS-I1: replace with createTenantModule({ hostRoot, store, openRuntime, configFor, logger })
 */
function createStubTenantModule(): TenantModule {
  let started = false;
  return {
    async start() {
      started = true;
    },
    get started() {
      return started;
    },
    resolve(_id: string): TenantResolution {
      return { kind: "not-found" };
    },
    async create(
      _input: { tenantId: string; name: string } & BootstrapPrincipal,
    ): Promise<{ envelope: TenantEnvelope; created: boolean }> {
      throw Object.assign(
        new Error("Tenant module not wired (Integration I1)"),
        { code: "not_wired" },
      );
    },
    async list(): Promise<readonly AdminTenant[]> {
      return [];
    },
    async status(_id: string): Promise<AdminTenantStatus | undefined> {
      return undefined;
    },
    async delete(
      _id: string,
      _activeWork: "refuse" | "drain" | "cancel",
    ): Promise<void> {
      throw Object.assign(
        new Error("Tenant module not wired (Integration I1)"),
        { code: "not_wired" },
      );
    },
    summarize(): HostAggregate {
      return {
        runningSessions: 0,
        connectedExecutors: 0,
        pendingActions: 0,
        uncertainEffects: 0,
      };
    },
    async close() {
      started = false;
    },
  };
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function resolveHostRoot(): string {
  const fromEnv = process.env.NYLORUN_HOME;
  const root =
    fromEnv && fromEnv.length > 0 ? fromEnv : resolve(homedir(), ".nylorun");
  return resolve(root);
}

export async function main(): Promise<void> {
  const hostRoot = resolveHostRoot();
  const paths = hostPaths(hostRoot);
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(paths.tmp, { recursive: true });
  mkdirSync(paths.tenants, { recursive: true });

  if (!existsSync(paths.config)) {
    throw new Error(
      `Missing host.json at ${paths.config}; run \`nylorun runtime up\` first`,
    );
  }
  if (!existsSync(paths.credentials)) {
    throw new Error(
      `Missing host-credentials.json at ${paths.credentials}; run \`nylorun runtime up\` first`,
    );
  }

  const config = loadJson<HostConfigFile>(paths.config);
  const credentials = loadJson<HostCredentialsFile>(paths.credentials);
  const logger = createHostLogger();
  const baseline = baselineEnvironment(process.env);
  // Document expected Host process env for supervisors; CLI spawn sets it explicitly.
  void hostProcessEnvironment(baseline, config, paths);

  const configFor = configForFactory({
    hostRoot,
    hostConfig: config,
    logger,
    baseline,
  });
  void configFor; // used when I1 wires openTenantRuntime

  const module = createStubTenantModule();
  const options: CreateHostOptions = {
    hostRoot,
    module,
    config,
    credentials,
    logger,
    coreVersion: coreVersion(),
  };
  const host = createHost(options);

  try {
    await host.listen();
  } catch (error) {
    if (error instanceof HostListenError) {
      logger.error("listen_failed", {
        message: error.message,
        exitCode: error.exitCode,
      });
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }

  const state: HostStateFile = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: RUNTIME_VERSION,
    entry,
    url: host.url,
  };
  writeFileSync(paths.state, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });

  logger.info("host_ready", { url: host.url, hostId: config.hostId });
  process.send?.({ type: "ready", url: host.url });

  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= host.close().then(() => {
      process.exit(0);
    });
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, shutdown);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  if (error instanceof HostListenError) {
    process.exit(error.exitCode);
  }
  process.exit(1);
});

export { EXIT_PORT_IN_USE, EXIT_NON_LOOPBACK };
