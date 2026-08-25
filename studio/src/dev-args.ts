import { resolve } from "node:path";

export type ParsedDevOptions = Readonly<{ project: string; port: number; studio: boolean; open: boolean }>;

function port(value: string, flag: string): number | string {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : `${flag} ${value} is not a port number.`;
}

export function parseDevArgs(argv: readonly string[], usage: string, cwd = process.cwd(), environment: NodeJS.ProcessEnv = process.env): ParsedDevOptions | string {
  let project = cwd; let studio = false; let open = true; let selectedPort: number | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return usage;
    if (arg === "--studio") { studio = true; continue; }
    if (arg === "--no-open") { open = false; continue; }
    if (arg === "--project" || arg === "--port") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("-")) return `${arg} needs a value.\n${usage}`;
      if (arg === "--project") project = value;
      else { const parsed = port(value, "--port"); if (typeof parsed === "string") return parsed; selectedPort = parsed; }
      continue;
    }
    return `Unknown dev option ${arg}.\n${usage}`;
  }
  const environmentPort = environment.PORT;
  const fallback = environmentPort === undefined ? 4111 : port(environmentPort, "PORT");
  if (typeof fallback === "string") return fallback;
  return Object.freeze({ project: resolve(project), port: selectedPort ?? fallback, studio, open });
}
