import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
export async function develop(args: readonly string[]): Promise<number> {
  if (
    new Set(args).size !== args.length ||
    args.some((arg) => !["--no-studio", "--no-open"].includes(arg))
  )
    throw new Error("Usage: nylorun dev [--no-studio] [--no-open]");
  const port = Number(process.env.PORT ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be between 1 and 65535");
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
  const child = spawn(
    process.execPath,
    [
      tsx,
      "watch",
      "--clear-screen=false",
      fileURLToPath(new URL("./dev-entry.js", import.meta.url)),
      ...args,
    ],
    // Deliver terminal shutdown once, through the supervisor, instead of twice through the terminal group.
    {
      stdio: "inherit",
      env: process.env,
      detached: process.platform !== "win32",
    }
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
        resolve(code ?? (signal === "SIGINT" ? 130 : 143))
      );
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}
