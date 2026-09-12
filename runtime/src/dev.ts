import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

/** Runs project development tooling without copying a supervisor into each application. */
export async function develop(args: readonly string[]): Promise<number> {
  const usage = "Usage: nylorun dev [--no-studio] [--no-open]";
  if (
    new Set(args).size !== args.length ||
    args.some((arg) => !["--no-studio", "--no-open"].includes(arg))
  )
    throw new Error(usage);
  const port = Number(process.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PORT must be an integer between 1 and 65535.");
  const require = createRequire(join(process.cwd(), "package.json"));
  let tsx: string;
  try {
    tsx = require.resolve("tsx/cli");
  } catch {
    throw new Error("Install tsx in your project to use nylorun dev.");
  }
  if (!args.includes("--no-studio")) {
    try {
      require.resolve("@nylorun/studio");
    } catch {
      throw new Error(
        "Install @nylorun/studio or use nylorun dev --no-studio."
      );
    }
  }

  const controller = new AbortController();
  const children = new Set<ChildProcess>();
  const exits: Promise<void>[] = [];
  let result = 0;
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = (code: number, signal: NodeJS.Signals = "SIGTERM") => {
    if (controller.signal.aborted) return;
    result = code;
    controller.abort();
    for (const child of children) child.kill(signal);
    force = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 5_000);
    force.unref();
  };
  const interrupt = () => stop(130, "SIGINT");
  const terminate = () => stop(143);
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  const launch = (argv: string[]) => {
    const child = spawn(process.execPath, argv, {
      stdio: "inherit",
      env: { ...process.env, NYLORUN_DEV: "1" },
    });
    children.add(child);
    exits.push(
      new Promise<void>((resolve) => {
        child.once("error", (error) => {
          console.error(
            `Could not start development process: ${error.message}`
          );
          stop(1);
        });
        child.once("close", (code, signal) => {
          children.delete(child);
          stop(
            code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)
          );
          resolve();
        });
      })
    );
  };
  try {
    launch([tsx, "watch", "src/index.ts"]);
    if (!args.includes("--no-studio")) {
      const url = `http://127.0.0.1:${port}/agents/v1/agents`;
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (!controller.signal.aborted && Date.now() < deadline) {
        try {
          const response = await fetch(url, {
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(500),
            ]),
          });
          ready = response.ok;
          await response.body?.cancel();
          if (ready) break;
        } catch {
          /* Watch mode may still be compiling or restarting the app. */
        }
        await delay(50, undefined, { signal: controller.signal }).catch(
          () => {}
        );
      }
      if (!controller.signal.aborted) {
        if (!ready)
          throw new Error(
            `Application did not become ready at ${url} within 20 seconds.`
          );
        launch([
          fileURLToPath(new URL("./cli.js", import.meta.url)),
          "studio",
          "--agent-url",
          `http://localhost:${port}/agents`,
          ...(args.includes("--no-open") ? ["--no-open"] : []),
        ]);
      }
    }
    await Promise.all(exits);
  } catch (error) {
    stop(1);
    await Promise.all(exits);
    throw error;
  } finally {
    if (force !== undefined) clearTimeout(force);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
  return result;
}
