import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createClient,
  connectAgents,
  type AgentSource,
  type AgentConnection,
} from "@nylorun/agents";
import { ensureHostModel } from "./model/host-model.js";
import { CliError } from "./errors.js";
import {
  ensureDataDir,
  loadScopeEnvironment,
  probeHealth,
  resolveScope,
  type Scope,
} from "./scope.js";
import { ensureRuntime } from "./runtime-host.js";

export interface LocalCredentials {
  serverKey: string;
  executors: Record<string, string>;
}

export async function localCredentials(
  path: string
): Promise<LocalCredentials> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    if (typeof value.serverKey !== "string" || !value.executors)
      throw new Error("Invalid local credentials");
    await chmod(path, 0o600);
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const value = { serverKey: randomBytes(32).toString("hex"), executors: {} };
    await writeFile(path, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    return value;
  }
}

export interface ExecutorScopeToken {
  token: string;
  agentId: string;
  implementationVersion: string;
}

/** Registers or rotates this project's executor credentials on the running host. */
export async function putExecutors(
  url: string,
  serverKey: string,
  executors: readonly ExecutorScopeToken[]
): Promise<void> {
  const response = await fetch(`${url}/v1/executors`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${serverKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ executors }),
  });
  if (!response.ok)
    throw new CliError(
      `The Runtime at ${url} rejected this project's executors (${response.status}): ${await response
        .text()
        .catch(() => "")}`
    );
}

export interface RunProjectOptions {
  studio?: boolean;
  open?: boolean;
  autostart?: boolean;
  scope?: Scope;
}

export async function runProject(
  entry: string,
  options: RunProjectOptions = {}
): Promise<void> {
  const scope = options.scope ?? resolveScope();
  loadScopeEnvironment(scope);
  const registry = await import(pathToFileURL(resolve(entry)).href);
  if (!Array.isArray(registry.agents) || !registry.agents.length)
    throw new Error(`${entry} must export a non-empty agents array`);
  const agents = registry.agents as AgentSource[];
  await ensureDataDir(scope);
  const credentials = await localCredentials(scope.credentialsPath);
  const version = process.env.NYLORUN_IMPLEMENTATION_VERSION ?? "dev";
  const scopes = agents.map((agent) => {
    const token = (credentials.executors[agent.id] ??=
      randomBytes(32).toString("hex"));
    return { token, agentId: agent.id, implementationVersion: version };
  });
  await writeFile(scope.credentialsPath, JSON.stringify(credentials), {
    mode: 0o600,
  });

  const url = scope.url;
  let studio: { close(): Promise<void>; address: string } | undefined;
  const connections: AgentConnection[] = [];
  let watchdog: NodeJS.Timeout | undefined;
  let stopping: Promise<void> | undefined;
  const close = () =>
    (stopping ??= (async () => {
      if (watchdog) clearInterval(watchdog);
      await Promise.allSettled(connections.map((c) => c.close()));
      await studio?.close().catch(() => {});
      for (const agent of agents) await (agent as any).close?.();
    })());
  // The Runtime is a separate, persistent process now, so shutting this one down leaves it up.
  const stop = () => void close().finally(() => (process.exitCode = 0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    await ensureRuntime(scope, { autostart: options.autostart !== false });
    await putExecutors(url, credentials.serverKey, scopes);
    if (process.env.NYLORUN_DEV_MODEL !== "fixture")
      await ensureHostModel({ runtimeUrl: url, serverKey: credentials.serverKey });
    const client = createClient({ url, key: credentials.serverKey });
    for (let index = 0; index < agents.length; index++) {
      await client.saveAgent(agents[index]!, {
        implementationVersion: version,
      });
      const connection = connectAgents({
        agents: [agents[index]!],
        implementationVersion: version,
        runtime: { url, key: scopes[index]!.token },
        onError: (error) =>
          console.error(
            "Executor:",
            error instanceof Error ? error.message : error
          ),
      });
      connections.push(connection);
      await connection.ready;
    }
    if (options.studio) {
      const modulePath = createRequire(
        join(process.cwd(), "package.json")
      ).resolve("@nylorun/studio");
      const module = await import(pathToFileURL(modulePath).href);
      studio = await module.startStudio({
        runtimeUrl: url,
        serverKey: credentials.serverKey,
        open: options.open !== false,
      });
      console.log(`Studio on ${studio!.address}`);
    }
    console.log(
      `Local project ready at ${url}; ${agents.length} connected agent(s).`
    );
    await new Promise<void>((settle) => {
      const finish = () => {
        if (!stopping) void close();
        settle();
      };
      process.once("SIGINT", finish);
      process.once("SIGTERM", finish);
      // Without a child to watch, a Runtime that dies would leave this process connected to
      // nothing; three consecutive failed probes end the run with a pointer to the log.
      let failures = 0;
      watchdog = setInterval(async () => {
        if (stopping) return;
        if ((await probeHealth(url, 2000)).health) return void (failures = 0);
        if (++failures < 3) return;
        console.error('Runtime stopped unexpectedly; see "nylorun logs".');
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
