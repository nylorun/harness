#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startStudio } from "./host.js";
import { parseStudioArgs } from "./args.js";
import { waitForApplicationConnection } from "./ready.js";

/** Host data directory for local-UI cache (never process.cwd()). */
function studioCacheDir(): string {
  const fromEnv = process.env.NYLORUN_HOME?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".nylorun");
}

export async function runStudioCli(
  argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
  const options = parseStudioArgs(argv);
  const connection = await waitForApplicationConnection();
  const dashboard = await startStudio({
    runtimeUrl: connection.url,
    serverKey: connection.key,
    tenant: { id: connection.tenant, name: connection.tenant },
    open: options.open,
    cacheDir: studioCacheDir(),
    ...(options.localUi ? { ui: "local" as const } : {}),
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  // Prefer launchUrl so pairing fragment is available to smokes and operators.
  console.log(`Studio on ${dashboard.launchUrl}`);
  if (
    !options.localUi &&
    dashboard.launchUrl.startsWith("https://local.nylorun.studio")
  ) {
    console.log(`Safari or offline: nylorun-studio --local-ui`);
  }
  await new Promise<void>((resolve, reject) => {
    const close = () => void dashboard.close().then(resolve, reject);
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  });
}

const invoked =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  void runStudioCli().then(
    () => {
      process.exitCode = process.exitCode ?? 0;
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
