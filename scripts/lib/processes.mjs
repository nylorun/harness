import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

/** Own every process started by a repository command, including failed starts. */
export class ProcessGroup {
  children = new Set();
  constructor({ log = console.log, onExit = () => {} } = {}) {
    this.log = log;
    this.onExit = onExit;
  }
  start(label, command, args, options = {}) {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      ...options,
    });
    const lines = [];
    const listeners = new Set();
    let ended = false;
    let intentional = false;
    let failure;
    const exit = new Promise((resolve) => {
      child.once("error", (error) => {
        failure = error;
        resolve(1);
      });
      // npm may exit before its script finishes cleanup. Wait for inherited pipes
      // to close as well, so readiness/shutdown covers the whole command.
      child.once("close", (code) => resolve(code ?? 1));
    }).then((code) => {
      ended = true;
      this.children.delete(handle);
      for (const listener of listeners) listener();
      if (!intentional) this.onExit(label, code);
      return code;
    });
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream }).on("line", (line) => {
        lines.push(line);
        if (lines.length > 500) lines.shift();
        this.log(`[${label}] ${line}`);
        for (const listener of listeners) listener();
      });
    }
    const handle = {
      child,
      exit,
      get ended() {
        return ended;
      },
      async line(predicate, timeout = 30_000) {
        return new Promise((resolve, reject) => {
          const finish = (error, line) => {
            clearTimeout(timer);
            listeners.delete(check);
            error ? reject(error) : resolve(line);
          };
          const check = () => {
            const line = lines.find(predicate);
            if (line !== undefined) finish(undefined, line);
            else if (ended)
              finish(
                failure ??
                  new Error(
                    `${label} exited before readiness.\n${lines.join("\n")}`,
                  ),
              );
          };
          const timer = setTimeout(
            () => finish(new Error(`${label} readiness timed out.`)),
            timeout,
          );
          listeners.add(check);
          check();
        });
      },
      async ready(url, timeout = 30_000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (ended)
            throw (
              failure ??
              new Error(
                `${label} exited before readiness.\n${lines.join("\n")}`,
              )
            );
          try {
            const response = await fetch(url, {
              signal: AbortSignal.timeout(1000),
            });
            await response.body?.cancel();
            if (response.ok) return;
          } catch {}
          await delay(100);
        }
        throw new Error(`${label} readiness timed out: ${url}`);
      },
      async stop() {
        intentional = true;
        if (ended) return;
        if (process.platform === "win32") {
          await new Promise((resolve) => {
            const killer = spawn(
              "taskkill",
              ["/pid", String(child.pid), "/T", "/F"],
              { stdio: "ignore" },
            );
            killer.once("error", resolve);
            killer.once("exit", resolve);
          });
        } else {
          try {
            process.kill(-child.pid, "SIGTERM");
          } catch {}
        }
        let timer;
        await Promise.race([
          exit,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 5000);
          }),
        ]);
        clearTimeout(timer);
        if (!ended) {
          try {
            process.platform === "win32"
              ? child.kill("SIGKILL")
              : process.kill(-child.pid, "SIGKILL");
          } catch {}
          await exit;
        }
      },
    };
    this.children.add(handle);
    return handle;
  }
  async close() {
    await Promise.all([...this.children].map((child) => child.stop()));
  }
}
