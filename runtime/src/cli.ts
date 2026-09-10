#!/usr/bin/env node
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { cp, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { build, createServer } from "vite";
import { defineRuntime } from "./config.js";
import type { RuntimeConfig } from "./config.js";
import { allowedHost, createRuntime, loopbackHosts } from "./server/host.js";
import {
  configureProvider,
  ConfigurationCancelled,
} from "./model/configure.js";
import { modelSelection } from "./model/settings.js";
import { modelsFor } from "./model/models.js";
import { ProjectCredentialStore } from "./model/auth-store.js";

const usage = `nylorun <dev|studio|configure|inspect|build|start>
  dev [--no-studio] [--no-open] [--port <n>] [--host <address>] [--allowed-hosts <list>]
  studio --agent-url <http(s)-url> [--port <n>] [--no-open]
  start [--port <n>] [--host <address>] [--allowed-hosts <list>]
Run from the directory containing nylorun.config.ts.
PORT, HOST and ALLOWED_HOSTS environment variables supply the same settings.`;
type Studio = { address: string; close(): Promise<void> };
async function studio(
  agentServerUrl: string,
  open: boolean,
  port?: number
): Promise<Studio> {
  let entry: string;
  try {
    entry = createRequire(join(process.cwd(), "package.json")).resolve(
      "@nylorun/studio"
    );
  } catch {
    throw new Error(
      "Install @nylorun/studio in this project, or run nylorun dev --no-studio."
    );
  }
  const module = await import(pathToFileURL(entry).href);
  return module.startStudio({
    agentServerUrl,
    open,
    ...(port === undefined ? {} : { port }),
  });
}
function port(value: string | undefined, fallback: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < 1 || result > 65535)
    throw new Error("Port must be an integer between 1 and 65535.");
  return result;
}
/**
 * Loopback binds answer only to their own address on the chosen port, so
 * development needs no setup. A published bind or an explicit allowed-host
 * list is the deployment decision; "*" accepts any Host header.
 */
function bindAddress(
  host: string | undefined,
  allowed: string | undefined,
  hostPort: number
): {
  hostname: string;
  reachable: string;
  loopback: boolean;
  hosts: readonly string[];
} {
  const hostname = (host?.trim() || "127.0.0.1").replace(/^\[(.*)\]$/u, "$1");
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(hostname);
  const configured = (allowed ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const hosts = configured.length
    ? [...(loopback ? loopbackHosts(hostPort) : []), ...configured]
    : loopback
    ? loopbackHosts(hostPort)
    : ["*"];
  const unspecified = ["0.0.0.0", "::"].includes(hostname);
  const reachable = unspecified
    ? "127.0.0.1"
    : hostname.includes(":")
    ? `[${hostname}]`
    : hostname;
  return { hostname, reachable, loopback, hosts };
}

async function sourceLoader() {
  const vite = await createServer({
    configFile: false,
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, hmr: false, ws: false },
    ssr: { external: true },
  });
  return {
    vite,
    async load(): Promise<RuntimeConfig> {
      const module = await vite.ssrLoadModule("/nylorun.config.ts");
      return defineRuntime(module.default);
    },
  };
}
async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  const allowed: Record<string, string[]> = {
    dev: ["--no-studio", "--no-open", "--port", "--host", "--allowed-hosts"],
    studio: ["--agent-url", "--port", "--no-open"],
    start: ["--port", "--host", "--allowed-hosts"],
    configure: [],
    inspect: [],
    build: [],
  };
  if (!(command in allowed)) throw new Error(usage);
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!allowed[command]!.includes(arg) || flags.has(arg))
      throw new Error(`Invalid option ${arg}\n${usage}`);
    if (["--port", "--agent-url", "--host", "--allowed-hosts"].includes(arg)) {
      const value = args[++i];
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value.`);
      flags.set(arg, value);
    } else flags.set(arg, true);
  }
  const requestedPort = flags.get("--port") as string | undefined;
  if (command === "configure") {
    const controller = new AbortController();
    const onInt = () => controller.abort(new ConfigurationCancelled("SIGINT"));
    const onTerm = () =>
      controller.abort(new ConfigurationCancelled("SIGTERM"));
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    try {
      const integrations = join(process.cwd(), ".env", "integrations.env");
      if (existsSync(integrations)) loadEnvFile(integrations);
      await configureProvider({ signal: controller.signal });
    } finally {
      process.removeListener("SIGINT", onInt);
      process.removeListener("SIGTERM", onTerm);
    }
    return;
  }
  let stopping = false;
  const shutdown: (() => Promise<unknown>)[] = [];
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const results = await Promise.allSettled(shutdown.map((close) => close()));
    if (results.some((result) => result.status === "rejected"))
      process.exitCode = 1;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  try {
    const integrations = join(process.cwd(), ".env", "integrations.env");
    if (existsSync(integrations)) loadEnvFile(integrations);
    if (command === "studio") {
      const url = flags.get("--agent-url");
      if (typeof url !== "string") throw new Error("--agent-url is required.");
      const dashboard = await studio(
        url,
        !flags.has("--no-open"),
        requestedPort ? port(requestedPort, 0) : undefined
      );
      shutdown.push(() => dashboard.close());
      console.log(`Studio on ${dashboard.address}`);
      return;
    }
    if (command === "build") {
      await build({
        configFile: false,
        build: {
          target: "node22",
          ssr: "nylorun.config.ts",
          outDir: "dist",
          rollupOptions: { output: { entryFileNames: "nylorun.config.js" } },
        },
        ssr: { external: true },
      });
      if (existsSync("agent")) {
        await mkdir("dist/agent", { recursive: true });
        await cp("agent", "dist/agent", {
          recursive: true,
          filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
        });
      }
      return;
    }
    let loader: Awaited<ReturnType<typeof sourceLoader>> | undefined;
    let config: RuntimeConfig;
    if (command === "start")
      config = defineRuntime(
        (await import(pathToFileURL(resolve("dist/nylorun.config.js")).href))
          .default
      );
    else {
      loader = await sourceLoader();
      shutdown.push(() => loader!.vite.close());
      config = await loader.load();
    }
    if (command === "inspect") {
      let setup: string = "required";
      try {
        const selected = modelSelection();
        setup = (await modelsFor(
          selected,
          new ProjectCredentialStore()
        ).checkAuth(selected.provider))
          ? "ready"
          : "required";
      } catch {
        /* Unconfigured is a valid inspection state. */
      }
      console.log(
        JSON.stringify(
          { agents: config.agents.map((agent) => agent.manifest), setup },
          null,
          2
        )
      );
      await stop();
      return;
    }
    let current = await createRuntime(config);
    const retained = [current];
    shutdown.push(async () => {
      await Promise.all(retained.map((runtime) => runtime.close()));
    });
    const fetch = async (request: Request) => {
      const path = new URL(request.url).pathname;
      const collection = path.match(/^\/agents\/([^/]+)\/v1\/sessions$/);
      if (request.method === "GET" && collection && retained.length > 1) {
        const response = await current.app.fetch(request);
        if (!response.ok) return response;
        const agentId = collection[1]!;
        const document = (await response.json()) as {
          sessions: { session: string; startedAt: number }[];
        };
        const summaries = new Map(
          document.sessions.map((item) => [item.session, item])
        );
        // A journal may be shared across reloads, but only the owning runtime
        // knows whether a retained session is still running or waiting.
        for (const runtime of retained) {
          if (runtime === current) continue;
          const previous = await runtime.app.fetch(request.clone());
          if (!previous.ok) continue;
          const history = (await previous.json()) as typeof document;
          for (const summary of history.sessions) {
            if (
              runtime.hasSession(agentId, summary.session) ||
              !summaries.has(summary.session)
            )
              summaries.set(summary.session, summary);
          }
        }
        return new Response(
          JSON.stringify({
            sessions: [...summaries.values()].sort(
              (a, b) => b.startedAt - a.startedAt
            ),
          }),
          { status: response.status, headers: response.headers }
        );
      }
      const match = path.match(
        /^\/agents\/([^/]+)\/v1\/(?:sessions|ag-ui\/sessions|media)\/([^/]+)/
      );
      let agentId = match?.[1];
      let sessionId = match?.[2];
      if (!match && request.method === "POST" && path.endsWith("/v1/ag-ui")) {
        agentId = path.split("/")[2];
        const body = await request
          .clone()
          .json()
          .catch(() => ({}));
        sessionId =
          typeof body.threadId === "string" ? body.threadId : undefined;
      }
      const runtime =
        agentId && sessionId
          ? [...retained]
              .reverse()
              .find((item) => item.hasSession(agentId!, sessionId!)) ?? current
          : current;
      return runtime.app.fetch(request);
    };
    const hostPort = port(requestedPort ?? process.env.PORT, 4111);
    const binding = bindAddress(
      (flags.get("--host") as string | undefined) ?? process.env.HOST,
      (flags.get("--allowed-hosts") as string | undefined) ??
        process.env.ALLOWED_HOSTS,
      hostPort
    );
    const guarded = async (request: Request) =>
      allowedHost(request.headers.get("host") ?? undefined, binding.hosts)
        ? fetch(request)
        : Response.json(
            {
              error:
                "Host header is not allowed. Set --allowed-hosts or ALLOWED_HOSTS.",
            },
            { status: 421 }
          );
    const server = serve({
      fetch: guarded,
      hostname: binding.hostname,
      port: hostPort,
    });
    shutdown.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        )
    );
    await new Promise<void>((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const address = `http://${binding.reachable}:${hostPort}`;
    console.log(`Agent runtime on ${address}`);
    if (!binding.loopback)
      console.log(
        binding.hosts.includes("*")
          ? "Serving every Host header; add TLS and access control at the network boundary."
          : `Serving Host headers: ${binding.hosts.join(", ")}`
      );
    if (command === "dev" && !flags.has("--no-studio")) {
      const dashboard = await studio(address, !flags.has("--no-open"));
      shutdown.push(() => dashboard.close());
      console.log(`Studio on ${dashboard.address}`);
    }
    if (loader) {
      let reload = Promise.resolve();
      loader.vite.watcher.on("all", (event, file) => {
        const path = relative(process.cwd(), file).split(sep).join("/");
        if (
          stopping ||
          !["add", "change", "unlink"].includes(event) ||
          isAbsolute(path) ||
          path.startsWith("..") ||
          !(path === "nylorun.config.ts" || path.startsWith("agent/"))
        )
          return;
        reload = reload.then(async () => {
          try {
            loader!.vite.moduleGraph.invalidateAll();
            const replacement = await createRuntime(await loader!.load());
            current = replacement;
            retained.push(replacement);
            console.log(`Reloaded ${path}`);
          } catch (error) {
            console.error(
              `Reload failed; existing agents remain active: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        });
      });
    }
  } catch (error) {
    await stop();
    throw error;
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode =
    error instanceof ConfigurationCancelled ? error.exitCode : 1;
});
