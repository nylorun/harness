import { spawn } from "node:child_process";

const child = spawn("codex", ["--version"], { stdio: "inherit" });
child.once("error", () => {
  process.stderr.write(
    "Codex CLI is unavailable. Install it and authenticate before using the Coding Agent.\n",
  );
  process.exitCode = 1;
});
child.once("exit", (code) => {
  if (code !== 0) {
    process.stderr.write(
      "Codex CLI is not ready. The Coding Agent manifest remains visible in Studio.\n",
    );
    process.exitCode = code ?? 1;
  }
});
