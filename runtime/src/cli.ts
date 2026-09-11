#!/usr/bin/env node
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { ConfigurationCancelled, configureProvider } from "./model/configure.js";

const usage = `nylorun <configure|studio>
  configure
  studio --agent-url <http(s)-url> [--port <n>] [--no-open]`;

async function startStudio(agentServerUrl: string, open: boolean, port?: number) {
  let entry: string;
  try {
    entry = createRequire(join(process.cwd(), "package.json")).resolve("@nylorun/studio");
  } catch {
    throw new Error("Install @nylorun/studio to use the Studio dashboard.");
  }
  const studio = await import(pathToFileURL(entry).href);
  return studio.startStudio({ agentServerUrl, open, ...(port === undefined ? {} : { port }) });
}

function parsePort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("--port must be an integer between 1 and 65535.");
  return port;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") return void console.log(usage);
  if (command === "configure") {
    if (args.length) throw new Error(usage);
    const controller = new AbortController();
    const cancel = (signal: "SIGINT" | "SIGTERM") => controller.abort(new ConfigurationCancelled(signal));
    process.once("SIGINT", () => cancel("SIGINT"));
    process.once("SIGTERM", () => cancel("SIGTERM"));
    const integrations = join(process.cwd(), ".env", "integrations.env");
    if (existsSync(integrations)) loadEnvFile(integrations);
    await configureProvider({ signal: controller.signal });
    return;
  }
  if (command !== "studio") throw new Error(usage);
  let agentUrl: string | undefined;
  let port: number | undefined;
  let open = true;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--agent-url") {
      if (agentUrl !== undefined) throw new Error("--agent-url may only be supplied once.");
      agentUrl = args[++index];
      if (!agentUrl || agentUrl.startsWith("--")) throw new Error("--agent-url requires a value.");
    } else if (arg === "--port") {
      if (port !== undefined) throw new Error("--port may only be supplied once.");
      port = parsePort(args[++index]);
    } else if (arg === "--no-open" && open) open = false;
    else throw new Error(usage);
  }
  if (!agentUrl) throw new Error("--agent-url is required.");
  const dashboard = await startStudio(agentUrl, open, port);
  console.log(`Studio on ${dashboard.address}`);
  await new Promise<void>((resolve, reject) => {
    const close = () => void dashboard.close().then(resolve, reject);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = error instanceof ConfigurationCancelled ? error.exitCode : 1;
});
