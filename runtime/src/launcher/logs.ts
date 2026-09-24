import { existsSync, readdirSync, statSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LauncherError } from "./errors.js";
import type { HostPaths } from "./paths.js";
import type { LauncherEvent } from "./protocol.js";

export interface LogsOptions {
  lines?: number;
  follow?: boolean;
  tenant?: string;
  all?: boolean;
  /** Called for each log line (JSON mode) or text line. */
  emit: (event: Extract<LauncherEvent, { type: "log" }>) => void;
  /** When set, follow until this aborts. */
  signal?: AbortSignal;
}

interface LogSource {
  path: string;
  source: "host" | "tenant";
  tenantId?: string;
}

function collectSources(
  paths: HostPaths,
  options: Pick<LogsOptions, "tenant" | "all">,
): LogSource[] {
  const sources: LogSource[] = [];
  if (!options.tenant) {
    sources.push({ path: paths.log, source: "host" });
  }
  if (options.tenant) {
    sources.push({
      path: join(paths.tenants, options.tenant, "logs", "tenant.log"),
      source: "tenant",
      tenantId: options.tenant,
    });
    return sources;
  }
  if (!options.all) return sources;

  let tenantDirs: string[] = [];
  try {
    tenantDirs = readdirSync(paths.tenants);
  } catch {
    return sources;
  }
  for (const id of tenantDirs) {
    if (id.startsWith(".")) continue;
    const logPath = join(paths.tenants, id, "logs", "tenant.log");
    if (!existsSync(logPath)) continue;
    sources.push({ path: logPath, source: "tenant", tenantId: id });
  }
  return sources;
}

/**
 * Read Host and Tenant log files (D§9.3). File reads only; no Host calls.
 */
export async function logs(
  paths: HostPaths,
  options: LogsOptions,
): Promise<void> {
  const lineCount = options.lines ?? 200;
  const sources = collectSources(paths, options);

  if (sources.length === 0 || !sources.some((s) => existsSync(s.path))) {
    throw new LauncherError(
      "not_found",
      `No Runtime log under ${paths.root}.`,
      'Start a Host with "nylorun-runtime up", then retry.',
    );
  }

  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    const text = await readFile(source.path, "utf8");
    const slice = text.trimEnd().split("\n").slice(-lineCount);
    for (const line of slice) {
      options.emit({
        type: "log",
        source: source.source,
        ...(source.tenantId ? { tenantId: source.tenantId } : {}),
        line,
      });
    }
  }

  if (!options.follow) return;

  const cursors = new Map<string, number>();
  for (const source of sources) {
    try {
      cursors.set(source.path, statSync(source.path).size);
    } catch {
      cursors.set(source.path, 0);
    }
  }

  await new Promise<void>((resolvePromise) => {
    const stop = () => {
      clearInterval(poll);
      resolvePromise();
    };
    if (options.signal) {
      if (options.signal.aborted) {
        stop();
        return;
      }
      options.signal.addEventListener("abort", stop, { once: true });
    }
    const poll = setInterval(async () => {
      for (const source of collectSources(paths, options)) {
        let next = 0;
        try {
          next = statSync(source.path).size;
        } catch {
          continue;
        }
        const size = cursors.get(source.path) ?? 0;
        if (next <= size) {
          cursors.set(source.path, next);
          continue;
        }
        const handle = await open(source.path, "r");
        const buffer = Buffer.alloc(next - size);
        await handle.read(buffer, 0, buffer.length, size);
        await handle.close();
        cursors.set(source.path, next);
        const chunk = buffer.toString("utf8");
        for (const line of chunk.split("\n")) {
          if (line === "" && !chunk.endsWith("\n")) continue;
          options.emit({
            type: "log",
            source: source.source,
            ...(source.tenantId ? { tenantId: source.tenantId } : {}),
            line,
          });
        }
      }
    }, 500);
    poll.unref();
  });
}
