import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DEV_FLAGS = [
  "--no-studio",
  "--no-open",
  "--no-autostart",
  "--ephemeral",
] as const;

/**
 * Everything that can be checked without contacting the Host, so a Project that
 * cannot run never causes a Runtime Host to be started on its behalf.
 */
export function developmentPreflight(args: readonly string[]): string {
  if (
    new Set(args).size !== args.length ||
    args.some((arg) => !(DEV_FLAGS as readonly string[]).includes(arg))
  )
    throw new Error(
      "Usage: nylorun dev [--no-studio] [--no-open] [--no-autostart] [--ephemeral]",
    );
  const require = createRequire(join(process.cwd(), "package.json"));
  let tsx: string;
  try {
    tsx = require.resolve("tsx/cli");
  } catch {
    throw new Error("Install tsx to use nylorun dev");
  }
  if (!args.includes("--no-studio"))
    try {
      require.resolve("@nylorun/studio");
    } catch {
      throw new Error("Install @nylorun/studio or use --no-studio");
    }
  return tsx;
}

export async function develop(args: readonly string[]): Promise<number> {
  const tsx = developmentPreflight(args);
  const child = spawn(
    process.execPath,
    [
      tsx,
      "watch",
      "--clear-screen=false",
      fileURLToPath(new URL("./dev-entry.js", import.meta.url)),
      ...args,
    ],
    {
      stdio: "inherit",
      env: process.env,
      detached: process.platform !== "win32",
    },
  );
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    child.kill(signal);
  };
  const interrupt = () => stop("SIGINT"),
    terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolve(code ?? (signal === "SIGINT" ? 130 : 143)),
      );
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
