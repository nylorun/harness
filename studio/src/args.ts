export type StudioCliOptions = Readonly<{
  port?: number;
  open: boolean;
  /** Force local UI (digest-pinned bundle). Default is hosted. */
  localUi: boolean;
}>;

function parsePort(value: string): number {
  if (!/^\d+$/u.test(value))
    throw new Error(`Invalid --port: ${value}`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`Invalid --port: ${value}`);
  return port;
}

/** Parse `nylorun-studio [--port <n>] [--no-open] [--local-ui]`. */
export function parseStudioArgs(argv: readonly string[]): StudioCliOptions {
  let port: number | undefined;
  let open = true;
  let localUi = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    if (arg === "--local-ui") {
      localUi = true;
      continue;
    }
    if (arg === "--port") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("-"))
        throw new Error("--port requires a value");
      port = parsePort(value);
      i += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = parsePort(arg.slice("--port=".length));
      continue;
    }
    if (arg === "--help" || arg === "-h")
      throw new Error(
        "Usage: nylorun-studio [--port <number>] [--no-open] [--local-ui]",
      );
    throw new Error(`Unknown argument: ${arg}`);
  }
  return Object.freeze({ port, open, localUi });
}
