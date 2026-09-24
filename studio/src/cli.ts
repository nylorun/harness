#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { startStudio } from "./host.js";
import { parseStudioArgs } from "./args.js";
import { waitForApplicationConnection } from "./ready.js";

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
    ...(options.port === undefined ? {} : { port: options.port }),
  });
  console.log(`Studio on ${dashboard.address}`);
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
