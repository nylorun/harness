#!/usr/bin/env node
import { startStudio } from "./host.js";

type StudioOptions = Readonly<{ agentServerUrl?: string; port?: number; open: boolean }>;

function usage(): string {
  return "nylo studio — open the Nylorun Studio dashboard\n\n  nylo studio --agent-server-url <http(s)-url> [--port <n>] [--no-open]";
}

function port(value: string, flag: string): number | string {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : `${flag} ${value} is not a port number.`;
}

function studioArgs(argv: readonly string[]): StudioOptions | string {
  let agentServerUrl: string | undefined; let studioPort: number | undefined; let open = true;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return usage();
    if (arg === "--no-open") { open = false; continue; }
    if (arg === "--agent-server-url" || arg === "--port") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) return `${arg} needs a value.\n${usage()}`;
      if (arg === "--agent-server-url") agentServerUrl = value;
      else { const parsed = port(value, "--port"); if (typeof parsed === "string") return parsed; studioPort = parsed; }
      continue;
    }
    return `Unknown Studio option ${arg}.\n${usage()}`;
  }
  if (agentServerUrl === undefined) return `--agent-server-url is required.\n${usage()}`;
  return Object.freeze({ agentServerUrl, ...(studioPort === undefined ? {} : { port: studioPort }), open });
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command !== "studio") { process.stdout.write(`${usage()}\n`); process.exitCode = 2; return; }
  const options = studioArgs(process.argv.slice(3));
  if (typeof options === "string") { process.stdout.write(`${options}\n`); process.exitCode = options === usage() ? 0 : 2; return; }
  const studio = await startStudio(options);
  process.stdout.write(`Studio on ${studio.address}\n`);
  process.stdout.write(`Agent Server ${studio.agentServerUrl}\n`);
  process.stdout.write("Bound to loopback. Press Ctrl-C to stop.\n");
  await new Promise<void>((stop) => process.once("SIGINT", stop));
  await studio.close();
}

void main().catch((error: unknown) => { process.stderr.write(`error ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; });
