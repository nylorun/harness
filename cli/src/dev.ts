import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { loadProjectEnvironment } from "./environment.js";
import { attachProject } from "./project/attach.js";
import { seedTenantFromProject } from "./project/seed.js";
import { requireProjectRoot } from "./project/root.js";

const DEV_FLAGS = ["--ephemeral"] as const;

export interface DevelopOptions {
  entry?: string;
  flags?: readonly string[];
  projectRoot?: string;
  home?: string;
}

/**
 * Everything that can be checked without contacting the Host, so a Project that
 * cannot run never causes a Runtime Host to be started on its behalf.
 */
export function developmentPreflight(
  args: readonly string[] = [],
): { tsx: string; entry: string; ephemeral: boolean } {
  const flags: string[] = [];
  let entry: string | undefined;
  for (const arg of args) {
    if ((DEV_FLAGS as readonly string[]).includes(arg)) {
      flags.push(arg);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(
        "Usage: nylorun dev [entry] [--ephemeral]\nDefault entry: src/main.ts",
      );
    }
    if (entry !== undefined) {
      throw new Error(
        "Usage: nylorun dev [entry] [--ephemeral]\nDefault entry: src/main.ts",
      );
    }
    entry = arg;
  }
  if (new Set(flags).size !== flags.length) {
    throw new Error(
      "Usage: nylorun dev [entry] [--ephemeral]\nDefault entry: src/main.ts",
    );
  }
  const require = createRequire(join(process.cwd(), "package.json"));
  let tsx: string;
  try {
    tsx = require.resolve("tsx/cli");
  } catch {
    throw new Error("Install tsx to use nylorun dev");
  }
  return {
    tsx,
    entry: entry ?? "src/main.ts",
    ephemeral: flags.includes("--ephemeral"),
  };
}

/**
 * `nylorun dev [entry]` — D§12 steps 1–4.
 * Spawns `tsx watch <entry>` with the three Project environment variables.
 */
export async function develop(
  options: DevelopOptions | readonly string[] = {},
): Promise<number> {
  const normalized: DevelopOptions = Array.isArray(options)
    ? { flags: options }
    : options;
  const projectRoot = normalized.projectRoot ?? requireProjectRoot();
  const previous = process.cwd();
  process.chdir(projectRoot);
  let preflight: ReturnType<typeof developmentPreflight>;
  try {
    preflight = developmentPreflight([
      ...(normalized.entry ? [normalized.entry] : []),
      ...(normalized.flags ?? []),
    ]);
  } finally {
    process.chdir(previous);
  }

  if (preflight.ephemeral) {
    const { runEphemeralDev } = await import("./runtime/ephemeral.js");
    return runEphemeralDev({
      entry: preflight.entry,
      projectRoot,
    });
  }

  const attached = await attachProject({
    projectRoot,
    ...(normalized.home ? { home: normalized.home } : {}),
  });
  const envMap = loadProjectEnvironment(projectRoot);
  await seedTenantFromProject({
    hostUrl: attached.link.hostUrl,
    tenantId: attached.link.tenantId,
    applicationKey: attached.credentials.applicationKey,
    projectRoot,
    env: envMap,
  });

  const entryPath = resolve(projectRoot, preflight.entry);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...envMap,
    NYLORUN_RUNTIME_URL: attached.link.hostUrl,
    NYLORUN_TENANT: attached.link.tenantId,
    NYLORUN_SERVER_KEY: attached.credentials.applicationKey,
  };

  printBanner({
    hostUrl: attached.link.hostUrl,
    hostStarted: attached.hostStarted,
    tenantName: attached.tenantName,
    tenantId: attached.link.tenantId,
    entry: preflight.entry,
  });

  const child = spawn(
    process.execPath,
    [preflight.tsx, "watch", "--clear-screen=false", entryPath],
    {
      cwd: projectRoot,
      stdio: "inherit",
      env: childEnv,
      detached: process.platform !== "win32",
    },
  );
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolvePromise(code ?? (signal === "SIGINT" ? 130 : 143)),
      );
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

function printBanner(options: {
  hostUrl: string;
  hostStarted: boolean;
  tenantName: string;
  tenantId: string;
  entry: string;
}): void {
  const hostNote = options.hostStarted
    ? "(started; stays running)"
    : "(already running)";
  const short =
    options.tenantId.length > 12
      ? `${options.tenantId.slice(0, 12)}…`
      : options.tenantId;
  console.log(`Host          ${options.hostUrl}  ${hostNote}`);
  console.log(`Tenant        ${options.tenantName}  ${short}`);
  console.log(`Entry         ${options.entry}`);
  console.log(`Studio: npm run studio`);
  console.log("");
  console.log("Ctrl-C stops this Project only.");
  console.log("nylorun runtime down  stops the Host.");
}
