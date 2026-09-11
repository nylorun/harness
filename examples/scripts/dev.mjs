import { spawn } from "node:child_process";
import { join } from "node:path";

const args = process.argv.slice(2);
if (
  args.some((arg) => arg !== "--no-open") ||
  args.filter((arg) => arg === "--no-open").length > 1
)
  throw new Error("Usage: npm run dev [-- --no-open]");

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer between 1 and 65535.");

const bin = (name) =>
  join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? `${name}.cmd` : name
  );
const spawnOptions = { stdio: "inherit", shell: process.platform === "win32" };
const app = spawn(bin("tsx"), ["watch", "src/index.ts"], spawnOptions);
let studio;
let stopping = false;

const exitCode = (code, signal) =>
  code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1);
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  for (const child of [app, studio]) child?.kill(signal);
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

app.once("exit", (code, signal) => {
  if (!stopping) {
    process.exitCode = exitCode(code, signal);
    stop("SIGTERM");
  }
});

try {
  await waitForReady(`http://127.0.0.1:${port}/agents/v1/agents`);
  if (stopping) process.exitCode ??= 0;
  else {
    studio = spawn(
      bin("nylorun"),
      [
        "studio",
        "--agent-url",
        `http://localhost:${port}/agents`,
        ...(args.includes("--no-open") ? ["--no-open"] : []),
      ],
      spawnOptions
    );
    studio.once("exit", (code, signal) => {
      if (!stopping) {
        process.exitCode = exitCode(code, signal);
        stop("SIGTERM");
      }
    });
  }
} catch (error) {
  process.exitCode = 1;
  console.error(error instanceof Error ? error.message : String(error));
  stop("SIGTERM");
}

async function waitForReady(url) {
  const deadline = Date.now() + 20_000;
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!stopping) throw new Error(`Application did not become ready at ${url}.`);
}
