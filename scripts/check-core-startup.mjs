// Startup only: no sessions, commands, customer functions, or model requests.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, connectAgents } from "@nylorun/agents";
import { startRuntime } from "@nylorun/runtime/core";
const directory = await mkdtemp(join(tmpdir(), "nylorun-startup-"));
const agent = Agent({ id: "startup-only", name: "Startup import check" });
let runtime, connection;
try {
  runtime = await startRuntime({
    sqlitePath: join(directory, "startup.sqlite"),
    serverToken: "startup-server-key-only",
    executors: [
      {
        token: "startup-executor-key-only",
        agentId: agent.id,
        implementationVersion: "dev",
      },
    ],
    port: 0,
  });
  for (const path of ["/health", "/ready"]) {
    const response = await fetch(runtime.url + path);
    if (!response.ok) throw new Error(path + " failed");
    console.log(path, response.status, await response.json());
  }
  connection = connectAgents({
    agents: [agent],
    runtime: { url: runtime.url, key: "startup-executor-key-only" },
  });
  let timer;
  try {
    await Promise.race([
      connection.ready,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Idle SSE startup timed out")),
          10000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  console.log(
    "Idle authenticated SSE connected and initial empty discovery completed."
  );
} finally {
  await connection?.close();
  await runtime?.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(
  "Executor and SQLite Runtime shut down cleanly. No functionality checks run."
);
