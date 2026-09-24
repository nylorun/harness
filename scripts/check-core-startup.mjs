// Startup only: no sessions, commands, customer functions, or model requests.
import { startTestTenant } from "../runtime/test/support/tenant.js";
import { Agent, connectAgents } from "@nylorun/agents";

const agent = Agent({ id: "startup-only", name: "Startup import check" });
let runtime, connection;
try {
  runtime = await startTestTenant({
    applicationKey: "startup-server-key-onlyyyy",
    executors: [
      {
        token: "startup-executor-key-only",
        agentId: agent.id,
        implementationVersion: "dev",
      },
    ],
  });
  const listed = await fetch(`${runtime.url}/v1/executors`, {
    headers: runtime.headers(),
  });
  if (!listed.ok) throw new Error("/v1/executors failed");
  console.log("/v1/executors", listed.status, await listed.json());
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
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  console.log(
    "Idle authenticated SSE connected and initial empty discovery completed.",
  );
} finally {
  await connection?.close();
  await runtime?.close();
}
console.log(
  "Executor and SQLite Runtime shut down cleanly. No functionality checks run.",
);
