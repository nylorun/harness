import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadProjectEnvironment } from "./environment.js";
import { attachProject } from "./project/attach.js";
import { seedTenantFromProject } from "./project/seed.js";
import { requireProjectRoot } from "./project/root.js";
import { resolveHome } from "./runtime/launcher.js";

const DEV_FLAGS = ["--ephemeral", "--local-ui", "--no-studio", "--no-open"] as const;

export interface DevelopOptions {
  entry?: string;
  flags?: readonly string[];
  projectRoot?: string;
  home?: string;
}

export type DevelopmentPreflight = {
  tsx: string;
  entry: string;
  ephemeral: boolean;
  localUi: boolean;
  studio: boolean;
  open: boolean;
};

/**
 * Everything that can be checked without contacting the Host, so a Project that
 * cannot run never causes a Runtime Host to be started on its behalf.
 */
export function developmentPreflight(
  args: readonly string[] = [],
): DevelopmentPreflight {
  const flags: string[] = [];
  let entry: string | undefined;
  for (const arg of args) {
    if ((DEV_FLAGS as readonly string[]).includes(arg)) {
      flags.push(arg);
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(
        "Usage: nylorun dev [entry] [--ephemeral] [--local-ui] [--no-studio] [--no-open]\nDefault entry: src/main.ts",
      );
    }
    if (entry !== undefined) {
      throw new Error(
        "Usage: nylorun dev [entry] [--ephemeral] [--local-ui] [--no-studio] [--no-open]\nDefault entry: src/main.ts",
      );
    }
    entry = arg;
  }
  if (new Set(flags).size !== flags.length) {
    throw new Error(
      "Usage: nylorun dev [entry] [--ephemeral] [--local-ui] [--no-studio] [--no-open]\nDefault entry: src/main.ts",
    );
  }
  const localUi = flags.includes("--local-ui");
  const noStudio = flags.includes("--no-studio");
  if (localUi && noStudio) {
    throw new Error("--local-ui cannot be combined with --no-studio.");
  }
  const require = createRequire(join(process.cwd(), "package.json"));
  let tsx: string;
  try {
    tsx = require.resolve("tsx/cli");
  } catch {
    throw new Error("Install tsx to use nylorun dev");
  }
  if (localUi) {
    try {
      require.resolve("@nylorun/studio");
    } catch {
      throw new Error("Install @nylorun/studio to use the Studio dashboard.");
    }
  }
  return {
    tsx,
    entry: entry ?? "src/main.ts",
    ephemeral: flags.includes("--ephemeral"),
    localUi,
    studio: localUi,
    open: !flags.includes("--no-open"),
  };
}

/**
 * Resolve `@nylorun/studio` from the Project and call `startStudio`.
 * Used by `nylorun studio` and `nylorun dev --local-ui`.
 */
export async function startStudio(options: {
  runtimeUrl: string;
  serverKey: string;
  tenant: { id: string; name: string };
  open: boolean;
  port?: number;
  /** When true, force local UI. When false/omit, use startStudio default (hosted). */
  localUi?: boolean;
  cacheDir?: string;
  projectRoot?: string;
}): Promise<{
  address: string;
  launchUrl: string;
  close(): Promise<void>;
}> {
  const projectRoot = options.projectRoot ?? process.cwd();
  let entry: string;
  try {
    entry = createRequire(join(projectRoot, "package.json")).resolve(
      "@nylorun/studio",
    );
  } catch {
    throw new Error("Install @nylorun/studio to use the Studio dashboard.");
  }
  const studio = await import(pathToFileURL(entry).href);
  const cacheDir = options.cacheDir ?? resolveHome();
  const ui = options.localUi ? ("local" as const) : undefined;
  return studio.startStudio({
    runtimeUrl: options.runtimeUrl,
    serverKey: options.serverKey,
    tenant: options.tenant,
    open: options.open,
    cacheDir,
    ...(ui === undefined ? {} : { ui }),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
}

/**
 * `nylorun dev [entry]` — D§12 steps 1–4.
 * Spawns `tsx watch <entry>` with the three Project environment variables.
 * `--local-ui` also starts the Studio proxy with a local dashboard.
 */
export async function develop(options: DevelopOptions = {}): Promise<number> {
  const normalized = options;
  const projectRoot = normalized.projectRoot ?? requireProjectRoot();
  const previous = process.cwd();
  process.chdir(projectRoot);
  let preflight: DevelopmentPreflight;
  try {
    preflight = developmentPreflight([
      ...(normalized.entry ? [normalized.entry] : []),
      ...(normalized.flags ?? []),
    ]);
  } finally {
    process.chdir(previous);
  }

  if (preflight.ephemeral) {
    const { startEphemeral } = await import("./runtime/ephemeral.js");
    const { writeLink } = await import("./project/link.js");
    const { writeCredentials } = await import("./project/credentials.js");
    const ephemeral = await startEphemeral({
      name: basename(projectRoot),
    });
    try {
      await writeCredentials(projectRoot, {
        applicationKey: ephemeral.applicationKey,
        principalId: "pr_ephemeral",
      });
      await writeLink(projectRoot, {
        hostUrl: ephemeral.url,
        hostId: ephemeral.hostId,
        tenantId: ephemeral.tenant.id,
      });
      const envMap = loadProjectEnvironment(projectRoot);
      await seedTenantFromProject({
        hostUrl: ephemeral.url,
        tenantId: ephemeral.tenant.id,
        applicationKey: ephemeral.applicationKey,
        projectRoot,
        env: envMap,
      });
      return await spawnWatcher({
        projectRoot,
        entry: preflight.entry,
        tsx: preflight.tsx,
        envMap,
        hostUrl: ephemeral.url,
        tenantId: ephemeral.tenant.id,
        applicationKey: ephemeral.applicationKey,
        tenantName: ephemeral.tenant.name,
        hostStarted: true,
        ephemeral: true,
        localUi: preflight.localUi,
        openStudio: preflight.open,
        home: normalized.home,
      });
    } finally {
      await ephemeral.close();
    }
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

  return spawnWatcher({
    projectRoot,
    entry: preflight.entry,
    tsx: preflight.tsx,
    envMap,
    hostUrl: attached.link.hostUrl,
    tenantId: attached.link.tenantId,
    applicationKey: attached.credentials.applicationKey,
    tenantName: attached.tenantName,
    hostStarted: attached.hostStarted,
    ephemeral: false,
    localUi: preflight.localUi,
    openStudio: preflight.open,
    home: normalized.home ?? attached.home,
  });
}

async function spawnWatcher(options: {
  projectRoot: string;
  entry: string;
  tsx: string;
  envMap: Record<string, string>;
  hostUrl: string;
  tenantId: string;
  applicationKey: string;
  tenantName: string;
  hostStarted: boolean;
  ephemeral: boolean;
  localUi: boolean;
  openStudio: boolean;
  home?: string;
}): Promise<number> {
  const entryPath = resolve(options.projectRoot, options.entry);
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.envMap,
    NYLORUN_RUNTIME_URL: options.hostUrl,
    NYLORUN_TENANT: options.tenantId,
    NYLORUN_SERVER_KEY: options.applicationKey,
  };

  let studio: { launchUrl: string; close(): Promise<void> } | undefined;
  let studioMode: "hosted" | "local" | undefined;
  if (options.localUi) {
    studio = await startStudio({
      runtimeUrl: options.hostUrl,
      serverKey: options.applicationKey,
      tenant: { id: options.tenantId, name: options.tenantName },
      open: options.openStudio,
      localUi: true,
      cacheDir: resolveHome(options.home),
      projectRoot: options.projectRoot,
    });
    studioMode = "local";
  }

  // Handle signals before the banner: a supervisor may stop us as soon as it
  // reads it, and an unhandled SIGTERM would kill this process and orphan the
  // detached watcher.
  let child: ReturnType<typeof spawn> | undefined;
  let stopping: NodeJS.Signals | undefined;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = signal;
    child?.kill(signal);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    printBanner({
      hostUrl: options.hostUrl,
      hostStarted: options.hostStarted,
      ephemeral: options.ephemeral,
      tenantName: options.tenantName,
      tenantId: options.tenantId,
      entry: options.entry,
      studioLaunchUrl: studio?.launchUrl,
      studioMode,
    });
    if (stopping) return stopping === "SIGINT" ? 130 : 143;

    const watcher = spawn(
      process.execPath,
      [options.tsx, "watch", "--clear-screen=false", entryPath],
      {
        cwd: options.projectRoot,
        stdio: "inherit",
        env: childEnv,
        detached: process.platform !== "win32",
      },
    );
    child = watcher;
    return await new Promise<number>((resolvePromise, reject) => {
      watcher.once("error", reject);
      watcher.once("exit", (code, signal) =>
        resolvePromise(code ?? (signal === "SIGINT" ? 130 : 143)),
      );
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    await studio?.close().catch(() => {});
  }
}

function printBanner(options: {
  hostUrl: string;
  hostStarted: boolean;
  ephemeral: boolean;
  tenantName: string;
  tenantId: string;
  entry: string;
  studioLaunchUrl?: string;
  studioMode?: "hosted" | "local";
}): void {
  const hostNote = options.ephemeral
    ? "(ephemeral; removed on exit)"
    : options.hostStarted
      ? "(started; stays running)"
      : "(already running)";
  const short =
    options.tenantId.length > 12
      ? `${options.tenantId.slice(0, 12)}…`
      : options.tenantId;
  console.log(`Host          ${options.hostUrl}  ${hostNote}`);
  console.log(`Tenant        ${options.tenantName}  ${short}`);
  console.log(`Entry         ${options.entry}`);
  if (options.studioLaunchUrl) {
    console.log(`Studio        ${options.studioLaunchUrl}`);
    if (options.studioMode === "hosted") {
      console.log(`Safari or offline: nylorun studio --local-ui`);
    }
  } else {
    console.log(`Studio: npm run studio`);
  }
  console.log("");
  console.log("Ctrl-C stops this Project only.");
  if (!options.ephemeral) {
    console.log("nylorun runtime down  stops the Host.");
  }
}
