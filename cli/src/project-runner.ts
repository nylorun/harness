import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createClient,
  connectAgents,
  type AgentSource,
  type AgentConnection,
} from "@nylorun/agents";
import { modelSelection } from "@nylorun/runtime/configuration";
import { loadProjectEnvironment } from "./environment.js";
export async function localCredentials(
  root = process.cwd()
): Promise<{ serverKey: string; executors: Record<string, string> }> {
  const directory = join(root, ".nylorun");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "local-credentials.json");
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
export async function runProject(
  entry: string,
  options: { studio?: boolean; open?: boolean } = {}
): Promise<void> {
  loadProjectEnvironment();
  if (process.env.NYLORUN_DEV_MODEL !== "fixture") modelSelection();
  const registry = await import(pathToFileURL(resolve(entry)).href);
  if (!Array.isArray(registry.agents) || !registry.agents.length)
    throw new Error(`${entry} must export a non-empty agents array`);
  const agents = registry.agents as AgentSource[];
  const credentials = await localCredentials();
  const version = process.env.NYLORUN_IMPLEMENTATION_VERSION ?? "dev";
  const scopes = agents.map((agent) => {
    const token = (credentials.executors[agent.id] ??=
      randomBytes(32).toString("hex"));
    return {
      token,
      agentId: agent.id,
      implementationVersion: version,
    };
  });
  await writeFile(
    join(process.cwd(), ".nylorun/local-credentials.json"),
    JSON.stringify(credentials),
    { mode: 0o600 }
  );
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535");
  const url = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined;
  let studio: { close(): Promise<void>; address: string } | undefined;
  const connections: AgentConnection[] = [];
  let stopping: Promise<void> | undefined;
  let intentionalStop = false;
  const close = () =>
    (stopping ??= (async () => {
      await Promise.allSettled(connections.map((c) => c.close()));
      await studio?.close().catch(() => {});
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
          child!.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      for (const agent of agents) await (agent as any).close?.();
    })());
  const stop = () => {
    intentionalStop = true;
    void close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    child = fork(
      createRequire(import.meta.url).resolve("@nylorun/runtime/server"),
      [],
      {
        execArgv: [],
        env: {
          ...process.env,
          HOST: "127.0.0.1",
          PORT: String(port),
          NYLORUN_PROJECT_PROVIDER: "1",
          NYLORUN_SERVER_KEY: credentials.serverKey,
          NYLORUN_EXECUTORS_JSON: JSON.stringify(scopes),
          NYLORUN_SQLITE_PATH:
            process.env.NYLORUN_SQLITE_PATH ??
            join(process.cwd(), ".nylorun/runtime.sqlite"),
        },
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      }
    );
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error("Local Runtime did not start within 20 seconds")),
        20000
      );
      const onReady = (message: unknown) => {
        if ((message as { type?: string })?.type === "ready") {
          cleanup();
          resolve();
        }
      };
      const onExit = (code: number | null) => {
        cleanup();
        reject(new Error(`Local Runtime exited (${code})`));
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        child!.off("message", onReady);
        child!.off("exit", onExit);
        child!.off("error", onError);
      };
      child!.on("message", onReady);
      child!.once("exit", onExit);
      child!.once("error", onError);
    });
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
    await new Promise<void>((resolve) => {
      child!.once("exit", () => {
        if (!intentionalStop && !stopping) process.exitCode = 1;
        resolve();
      });
      if (child!.exitCode !== null) resolve();
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await close();
  }
}
