import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  createClient,
  connectAgents,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  TENANT_HEADER,
  type AgentSource,
  type AgentConnection,
} from "@nylorun/agents";
import { startEphemeralRuntime } from "@nylorun/runtime";
import { ensureHostModel } from "./model/host-model.js";
import { CliError } from "./errors.js";
import { loadProjectEnvironment } from "./environment.js";
import { attachProject, type AttachedProject } from "./project/attach.js";
import { writeCredentials } from "./project/credentials.js";
import { writeLink } from "./project/link.js";
import { seedTenantFromProject } from "./project/seed.js";
import { findProjectRoot, requireProjectRoot } from "./project/root.js";
import { probeHostHealth } from "./host/root.js";

export interface ExecutorScopeToken {
  token: string;
  agentId: string;
  implementationVersion: string;
}

/** Registers or rotates this Project's executor credentials on the Tenant. */
export async function putExecutors(
  url: string,
  applicationKey: string,
  tenantId: string,
  executors: readonly ExecutorScopeToken[],
): Promise<void> {
  const response = await fetch(`${url}/v1/executors`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${applicationKey}`,
      [TENANT_HEADER]: tenantId,
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      "content-type": "application/json",
    },
    body: JSON.stringify({ executors }),
  });
  if (!response.ok)
    throw new CliError(
      `The Runtime at ${url} rejected this Project's executors (${response.status}): ${await response
        .text()
        .catch(() => "")}`,
    );
}

export interface RunProjectOptions {
  studio?: boolean;
  open?: boolean;
  autostart?: boolean;
  ephemeral?: boolean;
  projectRoot?: string;
}

export async function runProject(
  entry: string,
  options: RunProjectOptions = {},
): Promise<void> {
  const projectRoot = options.projectRoot ?? requireProjectRoot();
  const envMap = loadProjectEnvironment(projectRoot);

  let ephemeral:
    | {
        close(): Promise<void>;
        url: string;
        tenantId: string;
        applicationKey: string;
        hostRoot: string;
      }
    | undefined;
  let attached: AttachedProject;
  let hostStarted = false;

  if (options.ephemeral) {
    const hostRoot = await mkdtemp(join(tmpdir(), "nylorun-ephemeral-"));
    const baseline: Record<string, string> = {};
    if (process.env.PATH) baseline.PATH = process.env.PATH;
    if (process.env.LANG) baseline.LANG = process.env.LANG;
    if (process.env.TZ) baseline.TZ = process.env.TZ;
    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith("LC_") && value) baseline[key] = value;
    }
    const model =
      envMap.NYLORUN_DEV_MODEL?.trim() === "fixture" ||
      process.env.NYLORUN_DEV_MODEL?.trim() === "fixture"
        ? ({ kind: "fixture" } as const)
        : undefined;
    const started = await startEphemeralRuntime({
      hostRoot,
      baseline,
      ...(model ? { model } : {}),
      name: "ephemeral",
      retainRoot: true,
    });
    ephemeral = started;
    await writeCredentials(projectRoot, {
      applicationKey: started.applicationKey,
      principalId: "ephemeral",
      executors: {},
    });
    // Ephemeral Host has no durable hostId file exposed the same way; use health.
    const health = await probeHostHealth(started.url);
    const hostId = health.health?.hostId ?? "host_ephemeral";
    await writeLink(projectRoot, {
      hostUrl: started.url,
      hostId,
      tenantId: started.tenantId,
    });
    attached = {
      projectRoot,
      link: {
        hostUrl: started.url,
        hostId,
        tenantId: started.tenantId,
      },
      credentials: {
        applicationKey: started.applicationKey,
        principalId: "ephemeral",
        executors: {},
      },
      host: {
        state: "running",
        root: hostRoot,
        url: started.url,
        hostId,
      },
      tenantName: "ephemeral",
      hostStarted: true,
    };
    hostStarted = true;
  } else {
    attached = await attachProject({
      projectRoot,
      autostart: options.autostart !== false,
    });
    hostStarted = attached.hostStarted;
  }

  const { link, credentials } = attached;
  const url = link.hostUrl;
  const tenantId = link.tenantId;

  const registry = await import(pathToFileURL(resolve(projectRoot, entry)).href);
  if (!Array.isArray(registry.agents) || !registry.agents.length)
    throw new Error(`${entry} must export a non-empty agents array`);
  const agents = registry.agents as AgentSource[];

  const version =
    envMap.NYLORUN_IMPLEMENTATION_VERSION ??
    process.env.NYLORUN_IMPLEMENTATION_VERSION ??
    "dev";
  const nextCredentials = {
    ...credentials,
    executors: { ...credentials.executors },
  };
  const scopes = agents.map((agent) => {
    const token = (nextCredentials.executors[agent.id] ??=
      randomBytes(32).toString("hex"));
    return { token, agentId: agent.id, implementationVersion: version };
  });
  await writeCredentials(projectRoot, nextCredentials);

  await seedTenantFromProject({
    hostUrl: url,
    tenantId,
    applicationKey: nextCredentials.applicationKey,
    projectRoot,
    env: envMap,
  });

  let studio: { close(): Promise<void>; address: string } | undefined;
  const connections: AgentConnection[] = [];
  let watchdog: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  const close = () =>
    (stopping ??= (async () => {
      if (watchdog) clearInterval(watchdog);
      await Promise.allSettled(connections.map((c) => c.close()));
      await studio?.close().catch(() => {});
      for (const agent of agents) await (agent as { close?: () => Promise<void> }).close?.();
      if (ephemeral) {
        await ephemeral.close();
        await rm(ephemeral.hostRoot, { recursive: true, force: true }).catch(
          () => {},
        );
      }
    })());
  const stop = () => void close().finally(() => (process.exitCode = 0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await putExecutors(
      url,
      nextCredentials.applicationKey,
      tenantId,
      scopes,
    );
    if (
      envMap.NYLORUN_DEV_MODEL?.trim() !== "fixture" &&
      process.env.NYLORUN_DEV_MODEL?.trim() !== "fixture"
    ) {
      await ensureHostModel({
        runtimeUrl: url,
        serverKey: nextCredentials.applicationKey,
        tenantId,
        root: projectRoot,
        env: envMap,
      });
    }
    const client = createClient({
      url,
      key: nextCredentials.applicationKey,
      tenant: tenantId,
    });
    for (let index = 0; index < agents.length; index++) {
      await client.saveAgent(agents[index]!, {
        implementationVersion: version,
      });
      const connection = connectAgents({
        agents: [agents[index]!],
        implementationVersion: version,
        runtime: {
          url,
          key: scopes[index]!.token,
          tenant: tenantId,
        },
        onError: (error) =>
          console.error(
            "Executor:",
            error instanceof Error ? error.message : error,
          ),
      });
      connections.push(connection);
      await connection.ready;
    }
    if (options.studio) {
      const modulePath = createRequire(
        join(projectRoot, "package.json"),
      ).resolve("@nylorun/studio");
      const module = await import(pathToFileURL(modulePath).href);
      studio = await module.startStudio({
        runtimeUrl: url,
        serverKey: nextCredentials.applicationKey,
        tenant: { id: tenantId, name: attached.tenantName },
        open: options.open !== false,
      });
    }
    printBanner({
      hostUrl: url,
      hostStarted: hostStarted || Boolean(ephemeral),
      ephemeral: Boolean(ephemeral),
      tenantName: attached.tenantName,
      tenantId,
      studioAddress: studio?.address,
      agentCount: agents.length,
    });
    const sandbox = await (
      await import("./doctor.js")
    ).sandboxBanner(
      url,
      nextCredentials.applicationKey,
      agents.map((agent) => agent.manifest),
      tenantId,
    );
    if (sandbox) console.log(sandbox);

    await new Promise<void>((settle) => {
      const finish = () => {
        if (!stopping) void close();
        settle();
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      let failures = 0;
      watchdog = setInterval(async () => {
        if (stopping) return;
        if ((await probeHostHealth(url, 2000)).health) return void (failures = 0);
        if (++failures < 3) return;
        console.error('Runtime Host stopped unexpectedly; see "nylorun runtime logs".');
        process.exitCode = 1;
        finish();
      }, 5000);
      watchdog.unref();
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await close();
  }
}

function printBanner(options: {
  hostUrl: string;
  hostStarted: boolean;
  ephemeral: boolean;
  tenantName: string;
  tenantId: string;
  studioAddress?: string;
  agentCount: number;
}): void {
  const hostNote = options.ephemeral
    ? "(ephemeral; removed on exit)"
    : options.hostStarted
      ? "(started; stays running)"
      : "(already running)";
  const short =
    options.tenantId.length > 12
      ? `${options.tenantId.slice(0, 12)}…`
      : options.tenantId;
  console.log(`Host          ${options.hostUrl}  ${hostNote}`);
  console.log(`Tenant        ${options.tenantName}  ${short}`);
  if (options.studioAddress) console.log(`Studio        ${options.studioAddress}`);
  console.log(
    `Ready         ${options.agentCount} connected agent(s).`,
  );
  console.log("");
  console.log("Ctrl-C stops this Project only.");
  if (!options.ephemeral) {
    console.log('nylorun runtime down  stops the Host.');
  }
}

/** Resolve Project root for commands that may run outside attach. */
export function projectRootOrCwd(cwd = process.cwd()): string {
  return findProjectRoot(cwd) ?? cwd;
}

