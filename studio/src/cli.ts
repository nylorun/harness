#!/usr/bin/env node
import { resolve } from "node:path";
import { parseDevArgs } from "./dev-args.js";
import { startDevelopment } from "./dev.js";
import { startStudio } from "./host.js";

type StudioOptions = Readonly<{ project: string; agentServerUrl?: string; port?: number; open: boolean }>;
type DevOptions = Readonly<{ project: string; port: number; studio: boolean; open: boolean }>;

function usage(): string {
  return "nylo studio — open the Nylo Studio foundation\n\n  nylo studio [--project <dir>] [--agent-server-url <http(s)-url>] [--port <n>] [--no-open]\n  nylo dev [--studio] [--project <dir>] [--port <n>] [--no-open]";
}

function port(value: string, flag: string): number | string {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : `${flag} ${value} is not a port number.`;
}

function studioArgs(argv: readonly string[]): StudioOptions | string {
  let project = process.cwd(); let agentServerUrl: string | undefined; let studioPort: number | undefined; let open = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return usage();
    if (arg === "--no-open") { open = false; continue; }
    if (arg === "--project" || arg === "--agent-server-url" || arg === "--runtime-url" || arg === "--port") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) return `${arg} needs a value.\n${usage()}`;
      if (arg === "--project") project = value;
      else if (arg === "--agent-server-url" || arg === "--runtime-url") agentServerUrl = value;
      else { const parsed = port(value, "--port"); if (typeof parsed === "string") return parsed; studioPort = parsed; }
      continue;
    }
    return `Unknown Studio option ${arg}.\n${usage()}`;
  }
  return Object.freeze({ project: resolve(project), ...(agentServerUrl === undefined ? {} : { agentServerUrl }), ...(studioPort === undefined ? {} : { port: studioPort }), open });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "studio" && command !== "dev") {
    await import("@nylorun/runtime/cli");
    return;
  }
  if (command === "studio") {
    const options = studioArgs(process.argv.slice(3));
    if (typeof options === "string") { process.stdout.write(`${options}\n`); process.exitCode = options === usage() ? 0 : 2; return; }
    if (process.argv.includes("--runtime-url")) process.stderr.write("warning: --runtime-url is deprecated; use --agent-server-url instead.\n");
    const studio = await startStudio(options);
    process.stdout.write(`Studio on ${studio.address}\n`);
    if (studio.agentServerUrl !== "") process.stdout.write(`Agent Server ${studio.agentServerUrl}\n`);
    process.stdout.write("Bound to loopback. Press Ctrl-C to stop.\n");
    await new Promise<void>((stop) => process.once("SIGINT", stop));
    await studio.close();
    return;
  }
  const options = parseDevArgs(process.argv.slice(3), usage());
  if (typeof options === "string") { process.stdout.write(`${options}\n`); process.exitCode = options === usage() ? 0 : 2; return; }
  const dev = await startDevelopment(options);
  if (dev.studioAddress !== undefined) process.stdout.write(`Studio on ${dev.studioAddress}\n`);
  process.stdout.write(`Agent Server ${dev.agentServerUrl}\n`);
  process.stdout.write("Bound to loopback. Press Ctrl-C to stop.\n");
  await new Promise<void>((stop) => process.once("SIGINT", stop));
  await dev.close();
}

void main().catch((error: unknown) => { process.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
