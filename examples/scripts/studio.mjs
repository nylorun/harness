import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const port = Number(process.env.PORT ?? "4111");
const agentUrl = `http://127.0.0.1:${port}`;
const nylo = createRequire(import.meta.url).resolve("@nylorun/studio/dist/cli.js");
const server = (await ready(agentUrl, 300)) ? undefined : await startAgent(agentUrl);
const studio = spawn(process.execPath, [nylo, "studio", "--agent-server-url", agentUrl], {
  stdio: "inherit",
});
const stop = () => {
  server?.kill("SIGTERM");
  studio.kill("SIGTERM");
};

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
server?.once("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
  void ready(agentUrl, 200).then((up) => {
    if (!up) studio.kill("SIGTERM");
  });
});
studio.once("exit", (code) => {
  if (code && code !== 0) process.exitCode = code;
  server?.kill("SIGTERM");
});

async function startAgent(url) {
  if (!existsSync("dist/main.js")) {
    process.stderr.write(`No agent server on ${url}. Run \`npm run dev\` or \`npm run build\` first.\n`);
    process.exit(1);
  }
  const child = spawn(process.execPath, ["--env-file-if-exists=.env", "dist/main.js"], {
    stdio: "inherit",
  });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code ?? 1)));
  const outcome = await Promise.race([
    ready(url, 8_000).then((ok) => (ok ? "ready" : "timeout")),
    exited.then((code) => `exit:${code}`),
  ]);
  if (outcome !== "ready" && !(await ready(url, 300))) {
    process.stderr.write(`Agent server failed to start on ${url}.\n`);
    process.exit(1);
  }
  return child;
}

async function ready(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      if ((await fetch(`${url}/v1/agents`)).ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return false;
}
