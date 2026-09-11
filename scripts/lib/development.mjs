import { createServer } from "node:net";
import { join } from "node:path";
import { watch } from "chokidar";
import { ProcessGroup } from "./processes.mjs";
import { npmCli, root } from "./repo.mjs";

export function developmentOptions(args) {
  const options = { studio: true, open: true, port: 3000, studioPort: 4161 };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Repeated option: ${flag}`);
    seen.add(flag);
    if (flag === "--no-studio") options.studio = false;
    else if (flag === "--no-open") options.open = false;
    else if (flag === "--port" || flag === "--studio-port") {
      const text = args[++i];
      const value = Number(text);
      if (
        !/^\d+$/.test(text ?? "") ||
        !Number.isInteger(value) ||
        value < 1 ||
        value > 65535
      )
        throw new Error(`Invalid port for ${flag}`);
      options[flag === "--port" ? "port" : "studioPort"] = value;
    } else
      throw new Error(
        `Unknown option: ${flag}. Use --no-studio, --no-open, --port, --studio-port.`,
      );
  }
  if (options.studio && options.port === options.studioPort)
    throw new Error("Runtime and Studio need different ports.");
  return options;
}

export async function availablePort(port = 0) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", (error) =>
      reject(
        new Error(
          `Port ${port} is unavailable (${error.code}). Stop the other service or choose another port.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

/** A reusable runner for examples and disposable starter previews. */
export async function develop(
  options,
  {
    project = join(root, "examples"),
    repo = root,
    log = console.log,
    signal,
    built = false,
  } = {},
) {
  let stopping = false;
  let runtime, studio, watcher;
  let timer;
  let work = Promise.resolve();
  const pending = new Set();
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const group = new ProcessGroup({
    log,
    onExit(label, code) {
      if (!stopping && ["runtime", "studio"].includes(label)) {
        log(`[dev] ${label} exited (${code}); shutting down.`);
        void close(1);
      }
    },
  });
  const command = async (label, args, cwd) => {
    if (stopping) throw new Error("Development stopped.");
    const child = group.start(label, process.execPath, [npmCli(), ...args], {
      cwd,
    });
    if ((await child.exit) !== 0)
      throw new Error(`${label} failed; the running application was retained.`);
  };
  async function build(name, initial = false) {
    const cwd = join(repo, name);
    if (!initial) await command(`${name}:typecheck`, ["run", "typecheck"], cwd);
    await command(
      `${name}:build`,
      ["run", name === "studio" && !initial ? "build:server" : "build"],
      cwd,
    );
  }
  async function startRuntime() {
    if (stopping) return;
    runtime = group.start(
      "runtime",
      process.execPath,
      [npmCli(), "run", "dev"],
      { cwd: project, env: { ...process.env, PORT: String(options.port) } },
    );
    await runtime.ready(`http://127.0.0.1:${options.port}/agents/v1/agents`);
  }
  async function startStudio(open) {
    if (stopping || !options.studio) return;
    studio = group.start(
      "studio",
      process.execPath,
      [
        join(root, "scripts/studio-dev.mjs"),
        repo,
        String(options.port),
        String(options.studioPort),
        String(open),
      ],
      { cwd: repo },
    );
    await studio.ready(
      `http://127.0.0.1:${options.studioPort}/nylo-studio.config.json`,
    );
  }
  async function rebuild(names) {
    try {
      for (const name of names) await build(name);
      if (stopping) return;
      if (names.some((name) => name === "harness" || name === "runtime")) {
        log(
          "[dev] Restarting Runtime; active sessions end after package changes.",
        );
        await runtime.stop();
        await startRuntime();
      }
      if (names.includes("studio") && options.studio) {
        await studio.stop();
        await startStudio(false);
      }
    } catch (error) {
      if (!stopping) log(`[dev] ${error.message}`);
    }
  }
  async function close(code = 0) {
    if (stopping) return done;
    stopping = true;
    clearTimeout(timer);
    await watcher?.close();
    await group.close();
    await work;
    resolveDone(code);
    return code;
  }
  signal?.addEventListener("abort", () => void close(), { once: true });
  try {
    if (signal?.aborted) throw new Error("Development stopped.");
    await availablePort(options.port);
    if (options.studio) await availablePort(options.studioPort);
    if (!built)
      for (const name of [
        "harness",
        "runtime",
        ...(options.studio ? ["studio"] : []),
      ])
        await build(name, true);
    await startRuntime();
    await startStudio(options.open);
    log(
      `[dev] Runtime http://127.0.0.1:${options.port}${options.studio ? ` · Studio http://127.0.0.1:${options.studioPort}` : ""}`,
    );
    log(
      `[dev] Live conversations require provider setup: npm run configure --prefix ${JSON.stringify(project)}`,
    );
    if (stopping) throw new Error("Development stopped.");
    watcher = watch(
      ["harness", "runtime", ...(options.studio ? ["studio"] : [])].map(
        (name) => join(repo, name, "src"),
      ),
      { ignoreInitial: true },
    );
    watcher.on("all", (_event, path) => {
      if (stopping) return;
      const name = ["harness", "runtime", "studio"].find((name) =>
        path.startsWith(join(repo, name, "src")),
      );
      if (!name) return;
      pending.add(name);
      clearTimeout(timer);
      timer = setTimeout(() => {
        const names = [...pending];
        pending.clear();
        work = work.then(() => rebuild(names));
      }, 200);
    });
    await Promise.race([
      new Promise((resolve, reject) => {
        watcher.once("ready", resolve);
        watcher.once("error", reject);
      }),
      done.then(() => {
        throw new Error("Development stopped.");
      }),
    ]);
    watcher.on("error", (error) => {
      log(`[dev] Watcher failed: ${error.message}`);
      void close(1);
    });
    return { close, done };
  } catch (error) {
    await close(1);
    throw error;
  }
}
